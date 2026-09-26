import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './theme.css'

const TWO_HOURS = 2 * 60 * 60 * 1000

const queryClient = new QueryClient({
  // Matches the API's 2 h cache: anything already seen is reused when switching
  // host / model / view; the Refresh button reloads on demand.
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: TWO_HOURS, gcTime: TWO_HOURS } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
