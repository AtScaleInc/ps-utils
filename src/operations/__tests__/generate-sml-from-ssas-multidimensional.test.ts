import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { convertSsasMultidimensionalToXml } from "../generate-sml-from-ssas-multidimensional/ssas-md-converter.js";
import { convertXmlToSml } from "../generate-sml-from-xml/xml-converter.js";
import { buildLogger } from "../../logging.js";

/**
 * Synthetic SSAS Multidimensional XMLA fixture exercising the highest-risk
 * logic ported from the reference Go converter:
 *   - a role-play family: "Order Date" and "Ship Date" cube-dims both point at
 *     the same underlying "Dim Date" database dimension and must produce
 *     role_play relationships ("Order {0}" / "Ship {0}") instead of colliding.
 *   - a degenerate dimension ("Lookup"): its granularity attribute's key
 *     column lives on the SAME physical table as the fact, so it must be
 *     detected and reported rather than emitted as a cross-dataset join.
 *   - a many-to-many measure group dimension ("Promo"): must be detected and
 *     reported, not converted (matches the reference tool's own conservative
 *     M2M behavior).
 *   - a simple Sum measure that must convert to a metric.
 */
const FIXTURE_XMLA = `<Create xmlns="http://schemas.microsoft.com/analysisservices/2003/engine">
  <ObjectDefinition>
    <Database>
      <ID>TestDB</ID>
      <Name>TestDB</Name>
      <Dimensions>
        <Dimension>
          <ID>Dim Date</ID>
          <Name>Dim Date</Name>
          <Attributes>
            <Attribute>
              <ID>Date Key</ID>
              <Name>Date Key</Name>
              <Usage>Key</Usage>
              <KeyColumns>
                <KeyColumn>
                  <DataType>Integer</DataType>
                  <Source xsi:type="ColumnBinding">
                    <TableID>dim_date</TableID>
                    <ColumnID>date_key</ColumnID>
                  </Source>
                </KeyColumn>
              </KeyColumns>
              <NameColumn>
                <DataType>WChar</DataType>
                <Source xsi:type="ColumnBinding">
                  <TableID>dim_date</TableID>
                  <ColumnID>date_name</ColumnID>
                </Source>
              </NameColumn>
            </Attribute>
          </Attributes>
        </Dimension>
        <Dimension>
          <ID>Lookup Dim</ID>
          <Name>Lookup Dim</Name>
          <Attributes>
            <Attribute>
              <ID>Lookup Key</ID>
              <Name>Lookup Key</Name>
              <Usage>Key</Usage>
              <KeyColumns>
                <KeyColumn>
                  <DataType>Integer</DataType>
                  <Source xsi:type="ColumnBinding">
                    <TableID>fact_sales</TableID>
                    <ColumnID>lookup_key</ColumnID>
                  </Source>
                </KeyColumn>
              </KeyColumns>
            </Attribute>
          </Attributes>
        </Dimension>
        <Dimension>
          <ID>Promo Dim</ID>
          <Name>Promo Dim</Name>
          <Attributes>
            <Attribute>
              <ID>Promo Key</ID>
              <Name>Promo Key</Name>
              <Usage>Key</Usage>
              <KeyColumns>
                <KeyColumn>
                  <DataType>Integer</DataType>
                  <Source xsi:type="ColumnBinding">
                    <TableID>dim_promo</TableID>
                    <ColumnID>promo_key</ColumnID>
                  </Source>
                </KeyColumn>
              </KeyColumns>
            </Attribute>
          </Attributes>
        </Dimension>
      </Dimensions>
      <Cubes>
        <Cube>
          <ID>Sales</ID>
          <Name>Sales</Name>
          <Source>
            <DataSourceViewID>DSV</DataSourceViewID>
          </Source>
          <Dimensions>
            <Dimension>
              <ID>Order Date</ID>
              <Name>Order Date</Name>
              <DimensionID>Dim Date</DimensionID>
            </Dimension>
            <Dimension>
              <ID>Ship Date</ID>
              <Name>Ship Date</Name>
              <DimensionID>Dim Date</DimensionID>
            </Dimension>
            <Dimension>
              <ID>Lookup</ID>
              <Name>Lookup</Name>
              <DimensionID>Lookup Dim</DimensionID>
            </Dimension>
            <Dimension>
              <ID>Promo</ID>
              <Name>Promo</Name>
              <DimensionID>Promo Dim</DimensionID>
            </Dimension>
          </Dimensions>
          <MeasureGroups>
            <MeasureGroup>
              <ID>Fact Sales</ID>
              <Name>Fact Sales</Name>
              <Measures>
                <Measure>
                  <ID>Amount</ID>
                  <Name>Amount</Name>
                  <AggregateFunction>Sum</AggregateFunction>
                  <Source>
                    <DataType>Double</DataType>
                    <Source xsi:type="ColumnBinding">
                      <TableID>fact_sales</TableID>
                      <ColumnID>amount</ColumnID>
                    </Source>
                  </Source>
                </Measure>
              </Measures>
              <Dimensions>
                <Dimension xsi:type="RegularMeasureGroupDimension">
                  <CubeDimensionID>Order Date</CubeDimensionID>
                  <Attributes>
                    <Attribute>
                      <AttributeID>Date Key</AttributeID>
                      <KeyColumns>
                        <KeyColumn>
                          <DataType>Integer</DataType>
                          <Source xsi:type="ColumnBinding">
                            <TableID>fact_sales</TableID>
                            <ColumnID>order_date_key</ColumnID>
                          </Source>
                        </KeyColumn>
                      </KeyColumns>
                      <Type>Granularity</Type>
                    </Attribute>
                  </Attributes>
                </Dimension>
                <Dimension xsi:type="RegularMeasureGroupDimension">
                  <CubeDimensionID>Ship Date</CubeDimensionID>
                  <Attributes>
                    <Attribute>
                      <AttributeID>Date Key</AttributeID>
                      <KeyColumns>
                        <KeyColumn>
                          <DataType>Integer</DataType>
                          <Source xsi:type="ColumnBinding">
                            <TableID>fact_sales</TableID>
                            <ColumnID>ship_date_key</ColumnID>
                          </Source>
                        </KeyColumn>
                      </KeyColumns>
                      <Type>Granularity</Type>
                    </Attribute>
                  </Attributes>
                </Dimension>
                <Dimension xsi:type="DegenerateMeasureGroupDimension">
                  <CubeDimensionID>Lookup</CubeDimensionID>
                  <Attributes>
                    <Attribute>
                      <AttributeID>Lookup Key</AttributeID>
                      <KeyColumns>
                        <KeyColumn>
                          <DataType>Integer</DataType>
                          <Source xsi:type="ColumnBinding">
                            <TableID>fact_sales</TableID>
                            <ColumnID>lookup_key</ColumnID>
                          </Source>
                        </KeyColumn>
                      </KeyColumns>
                      <Type>Granularity</Type>
                    </Attribute>
                  </Attributes>
                </Dimension>
                <Dimension xsi:type="ManyToManyMeasureGroupDimension">
                  <CubeDimensionID>Promo</CubeDimensionID>
                  <MeasureGroupID>Fact Promo Bridge</MeasureGroupID>
                </Dimension>
              </Dimensions>
            </MeasureGroup>
          </MeasureGroups>
        </Cube>
      </Cubes>
      <DataSourceViews>
        <DataSourceView>
          <ID>DSV</ID>
          <Name>DSV</Name>
          <Schema>
            <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:msprop="urn:schemas-microsoft-com:xml-msprop">
              <xs:element name="TestDB">
                <xs:complexType>
                  <xs:choice>
                    <xs:element name="dim_date" msprop:DbTableName="dim_date">
                      <xs:complexType>
                        <xs:sequence>
                          <xs:element name="date_key" msprop:DbColumnName="date_key" type="xs:int" />
                          <xs:element name="date_name" msprop:DbColumnName="date_name" />
                        </xs:sequence>
                      </xs:complexType>
                    </xs:element>
                    <xs:element name="dim_promo" msprop:DbTableName="dim_promo">
                      <xs:complexType>
                        <xs:sequence>
                          <xs:element name="promo_key" msprop:DbColumnName="promo_key" type="xs:int" />
                        </xs:sequence>
                      </xs:complexType>
                    </xs:element>
                    <xs:element name="fact_sales" msprop:DbTableName="fact_sales">
                      <xs:complexType>
                        <xs:sequence>
                          <xs:element name="order_date_key" msprop:DbColumnName="order_date_key" type="xs:int" />
                          <xs:element name="ship_date_key" msprop:DbColumnName="ship_date_key" type="xs:int" />
                          <xs:element name="lookup_key" msprop:DbColumnName="lookup_key" type="xs:int" />
                          <xs:element name="amount" msprop:DbColumnName="amount" type="xs:decimal" />
                        </xs:sequence>
                      </xs:complexType>
                    </xs:element>
                  </xs:choice>
                </xs:complexType>
              </xs:element>
            </xs:schema>
          </Schema>
        </DataSourceView>
      </DataSourceViews>
    </Database>
  </ObjectDefinition>
</Create>`;

async function convert() {
  const logger = buildLogger({});
  const { projectXml, issues } = await convertSsasMultidimensionalToXml(
    FIXTURE_XMLA,
    { xmlaFileName: "fixture.xml" },
    logger,
  );
  const sml = await convertXmlToSml(projectXml, { xmlFileName: "fixture.xml" }, logger);
  return { projectXml, issues, sml };
}

describe("generate-sml-from-ssas-multidimensional converter", () => {
  it("wires role-played date dimensions into a single dimension with distinct role_play labels", async () => {
    const { sml } = await convert();
    expect(sml.has("dimensions/dim-date.yml")).toBe(true);
    expect(sml.has("dimensions/order-date.yml")).toBe(false);
    expect(sml.has("dimensions/ship-date.yml")).toBe(false);

    const model = load([...sml.entries()].find(([k]) => k.startsWith("models/"))![1]) as any;
    const dateRels = model.relationships.filter((r: any) => r.to.dimension === "Dim Date");
    expect(dateRels).toHaveLength(2);
    expect(dateRels.map((r: any) => r.role_play).sort()).toEqual(["Order {0}", "Ship {0}"]);
  });

  it("converts a simple measure to a metric", async () => {
    const { sml } = await convert();
    const metric = load(sml.get("metrics/amount.yml")!) as any;
    expect(metric.calculation_method).toBe("sum");
  });

  it("detects but does not convert the many-to-many relationship", async () => {
    const { issues, sml } = await convert();
    expect(issues.some((i) => i.category === "many_to_many_not_converted")).toBe(true);
    const model = load([...sml.entries()].find(([k]) => k.startsWith("models/"))![1]) as any;
    expect(model.relationships.some((r: any) => r.to.dimension === "Promo")).toBe(false);
  });

  it("detects the degenerate dimension instead of emitting a cross-dataset join", async () => {
    const { issues, sml } = await convert();
    expect(issues.some((i) => i.category === "degenerate_dimension")).toBe(true);
    const model = load([...sml.entries()].find(([k]) => k.startsWith("models/"))![1]) as any;
    expect(model.relationships.some((r: any) => r.to.dimension === "Lookup")).toBe(false);
  });
});
