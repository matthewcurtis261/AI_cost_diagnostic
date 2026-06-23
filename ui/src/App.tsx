import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Sources from './pages/Sources'
import SourceDetail from './pages/SourceDetail'
import AnalyzeInputs from './pages/AnalyzeInputs'
import AgentUsage from './pages/AgentUsage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/sources" element={<Sources />} />
      <Route path="/sources/:id" element={<SourceDetail />} />
      <Route path="/analyze" element={<AnalyzeInputs />} />
      <Route path="/agent-usage" element={<AgentUsage />} />
    </Routes>
  )
}
