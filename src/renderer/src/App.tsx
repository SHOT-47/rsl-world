import { useEffect, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowUpRight, BookOpen, Bot, CheckCircle2, ChevronDown,
  CircleHelp, Clock3, Code2, Folder, GitBranch, Layers3, LockKeyhole, PanelLeft,
  Plus, Search, Settings2, ShieldCheck, Sparkles, TerminalSquare, Workflow
} from 'lucide-react'
import type { BootstrapInfo, PendingApprovalSummary, CaseInitializationResult, CaseValidationResult, EvidenceArtifact, ProjectRootSelection, ProviderConfigInput, ProviderKind, ProviderSummary, ProviderTestResult, RuntimeEvent, RslHarnessId, RslExportResult, RslValidationResult, TaskSummary } from '@shared/contracts'

type Area = 'workbench' | 'projects' | 'activity' | 'rsl' | 'settings'

export default function App() {
  const [activeArea, setActiveArea] = useState<Area>('workbench')
  const [bootstrap, setBootstrap] = useState<BootstrapInfo | null>(null)
  const [projectRoot, setProjectRoot] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [selectedMode, setSelectedMode] = useState<TaskSummary['mode']>('coding')
  const [targetApiBaseUrl, setTargetApiBaseUrl] = useState('')
  const [targetApiPaths, setTargetApiPaths] = useState('')
  const [targetApiAuthorized, setTargetApiAuthorized] = useState(false)
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [approvals, setApprovals] = useState<PendingApprovalSummary[]>([])
  const [events, setEvents] = useState<RuntimeEvent[]>([])
  const [evidence, setEvidence] = useState<EvidenceArtifact[]>([])
  const [rslStatus, setRslStatus] = useState<RslValidationResult | null>(null)
  const [caseStatus, setCaseStatus] = useState<CaseValidationResult | null>(null)
  const [caseInitStatus, setCaseInitStatus] = useState<CaseInitializationResult | null>(null)
  const [selectedHarness, setSelectedHarness] = useState<RslHarnessId>('codex')
  const [exportResult, setExportResult] = useState<RslExportResult | null>(null)
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [providerName, setProviderName] = useState('Local OpenAI-compatible')
  const [providerKind, setProviderKind] = useState<ProviderKind>('local')
  const [providerBaseUrl, setProviderBaseUrl] = useState('http://127.0.0.1:11434/v1')
  const [providerModel, setProviderModel] = useState('qwen2.5-coder')
  const [providerApiKey, setProviderApiKey] = useState('')
  const [clearProviderKey, setClearProviderKey] = useState(false)
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null)
  const [providerDiagnostics, setProviderDiagnostics] = useState<Record<string, ProviderTestResult>>({})

  useEffect(() => {
    let mounted = true
    window.workbench.getBootstrap().then(result => {
      if (!mounted) return
      if (result.ok) {
        setBootstrap(result.data)
        setNotice('Browser preview: task execution and local file inspection require a secure web backend, which is not connected yet.')
      } else setNotice(result.error.message)
    }).catch(() => mounted && setNotice('The runtime bridge is unavailable.'))
    window.workbench.listTasks().then(result => {
      if (!mounted) return
      if (result.ok) setTasks(result.data)
      else setNotice(result.error.message)
    }).catch(() => mounted && setNotice('Could not load the local task list.'))
    window.workbench.listEvents().then(result => {
      if (mounted && result.ok) setEvents(result.data)
    }).catch(() => undefined)
    window.workbench.listPendingApprovals().then(result => {
      if (mounted && result.ok) setApprovals(result.data)
    }).catch(() => undefined)
    window.workbench.listProviders().then(result => {
      if (!mounted) return
      if (result.ok) setProviders(result.data)
      else setNotice(result.error.message)
    }).catch(() => mounted && setNotice('Could not load local provider settings.'))
    window.workbench.validateRsl().then(result => {
      if (!mounted) return
      if (result.ok) setRslStatus(result.data)
      else setNotice(result.error.message)
    }).catch(() => mounted && setNotice('The bundled RSL validator could not be started.'))
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    let mounted = true
    const unsubscribe = window.workbench.onRuntimeEvent((event) => {
      if (!mounted) return
      setEvents(previous => [event, ...previous.filter(item => item.id !== event.id)].slice(0, 250))
      window.workbench.listTasks(projectRoot ?? undefined).then(result => {
        if (mounted && result.ok) setTasks(result.data)
      }).catch(() => undefined)
      window.workbench.listPendingApprovals().then(result => {
        if (mounted && result.ok) setApprovals(result.data)
      }).catch(() => undefined)
      if (projectRoot) window.workbench.listEvidence(projectRoot).then(result => {
        if (mounted && result.ok) setEvidence(result.data)
      }).catch(() => undefined)
    })
    return () => { mounted = false; unsubscribe() }
  }, [projectRoot])

  async function refreshTasks(root?: string | null) {
    const result = await window.workbench.listTasks(root ?? undefined)
    if (result.ok) setTasks(result.data)
    else setNotice(result.error.message)
  }

  async function refreshEvents() {
    const result = await window.workbench.listEvents()
    if (result.ok) setEvents(result.data)
  }

  async function refreshApprovals() {
    const result = await window.workbench.listPendingApprovals()
    if (result.ok) setApprovals(result.data)
    else setNotice(result.error.message)
  }

  async function decideApproval(requestId: string, decision: 'approve' | 'deny') {
    setBusyAction(`approval:${requestId}`)
    try {
      const result = await window.workbench.respondToApproval({ requestId, decision })
      if (result.ok && result.data.accepted) {
        setNotice(decision === 'approve' ? 'Exact action approved. The runtime will revalidate the approved parameters before execution.' : 'Action denied. The runtime will not execute that operation.')
        await Promise.all([refreshApprovals(), refreshEvents(), refreshTasks(projectRoot)])
      } else if (result.ok) {
        setNotice('This approval is no longer pending or has expired. It cannot authorize an action.')
        await refreshApprovals()
      } else setNotice(result.error.message)
    } catch { setNotice('Approval decision could not be recorded.') }
    finally { setBusyAction(null) }
  }

  async function resumeTask(taskId: string) {
    setBusyAction(`resume:${taskId}`)
    try {
      const result = await window.workbench.resumeTask({ taskId })
      if (result.ok) {
        setTasks(previous => [result.data, ...previous.filter(task => task.id !== result.data.id)].slice(0, 200))
        setNotice('Task resumed from its validated transcript checkpoint. Expired approvals must be granted again; uncertain side effects are not resumed automatically.')
        await Promise.all([refreshEvents(), refreshApprovals()])
      } else setNotice(result.error.message)
    } catch { setNotice('Task could not be resumed safely.') }
    finally { setBusyAction(null) }
  }

  async function refreshEvidence(root: string) {
    const result = await window.workbench.listEvidence(root)
    if (result.ok) setEvidence(result.data)
    else setNotice(result.error.message)
  }

  async function validateRsl() {
    setBusyAction('validate-rsl')
    try {
      const result = await window.workbench.validateRsl()
      if (result.ok) setRslStatus(result.data)
      else setNotice(result.error.message)
    } catch { setNotice('Could not run the bundled RSL validator.') }
    finally { setBusyAction(null) }
  }

  async function validateCase() {
    if (!projectRoot) { setNotice('Select a project folder first.'); setActiveArea('projects'); return }
    setBusyAction('validate-case')
    try {
      const result = await window.workbench.validateCase(projectRoot)
      if (result.ok) {
        setCaseStatus(result.data)
        setNotice(result.data.passed ? 'RSL case validation passed.' : result.data.summary)
      } else setNotice(result.error.message)
    } catch { setNotice('Could not validate the project case.') }
    finally { setBusyAction(null) }
  }

  async function initializeCase() {
    if (!projectRoot) { setNotice('Select a project folder before initializing an RSL case.'); setActiveArea('projects'); return }
    setBusyAction('initialize-case')
    try {
      const result = await window.workbench.initializeCase(projectRoot)
      if (result.ok) {
        setCaseInitStatus(result.data)
        setNotice(result.data.summary)
      } else setNotice(result.error.message)
    } catch { setNotice('Could not initialize the RSL case scaffold.') }
    finally { setBusyAction(null) }
  }

  async function exportRslSkill() {
    setBusyAction('export-rsl')
    try {
      const result = await window.workbench.exportRslSkill(selectedHarness)
      if (result.ok) {
        setExportResult(result.data)
        setNotice(result.data.summary)
      } else setNotice(result.error.message)
    } catch { setNotice('RSL skill export failed.') }
    finally { setBusyAction(null) }
  }

  async function inspectEvidence() {
    if (!projectRoot) { setNotice('Select a project folder before inspecting evidence.'); setActiveArea('projects'); return }
    setBusyAction('inspect-evidence')
    try {
      const result = await window.workbench.inspectEvidenceFile(projectRoot)
      if (!result.ok) setNotice(result.error.message)
      else if (result.data) {
        setNotice(`Evidence recorded: ${result.data.relativePath} · SHA-256 ${result.data.sha256.slice(0, 12)}…`)
        await refreshEvidence(projectRoot)
        await refreshEvents()
      }
    } catch { setNotice('Evidence inspection failed. Confirm the file is inside the selected project.') }
    finally { setBusyAction(null) }
  }

  async function refreshProviders() {
    const result = await window.workbench.listProviders()
    if (result.ok) setProviders(result.data)
    else setNotice(result.error.message)
  }

  function prepareNewProvider() {
    setEditingProviderId(null)
    setProviderName(providerKind === 'local' ? 'Local OpenAI-compatible' : 'Cloud OpenAI-compatible')
    setProviderApiKey('')
    setClearProviderKey(false)
    setProviderBaseUrl(providerKind === 'local' ? 'http://127.0.0.1:11434/v1' : 'https://api.openai.com/v1')
    setProviderModel(providerKind === 'local' ? 'qwen2.5-coder' : 'gpt-4.1-mini')
  }

  function editProvider(provider: ProviderSummary) {
    setEditingProviderId(provider.id)
    setProviderName(provider.name)
    setProviderKind(provider.kind)
    setProviderBaseUrl(provider.baseUrl)
    setProviderModel(provider.model)
    setProviderApiKey('')
    setClearProviderKey(false)
  }

  async function saveProvider() {
    setBusyAction('save-provider')
    try {
      const input: ProviderConfigInput = {
        ...(editingProviderId ? { id: editingProviderId } : {}),
        name: providerName.trim(), kind: providerKind, baseUrl: providerBaseUrl.trim(), model: providerModel.trim(),
        ...(providerApiKey.trim() ? { apiKey: providerApiKey } : {}),
        ...(clearProviderKey ? { clearApiKey: true } : {})
      }
      const result = await window.workbench.saveProvider(input)
      if (!result.ok) setNotice(result.error.message)
      else {
        setProviderApiKey('')
        setClearProviderKey(false)
        setEditingProviderId(null)
        setNotice(`Saved provider '${result.data.name}'. The credential is OS-encrypted; coding tasks may run when this provider is active. Other task modes remain gated until their evidence workflows are integrated.`)
        await refreshProviders()
      }
    } catch { setNotice('Provider could not be saved. The secret was not intentionally logged; inspect local application diagnostics.') }
    finally { setBusyAction(null) }
  }

  async function testProvider(providerId: string) {
    setBusyAction(`test-provider:${providerId}`)
    try {
      const result = await window.workbench.testProvider(providerId)
      if (result.ok) {
        setProviderDiagnostics(previous => ({ ...previous, [providerId]: result.data }))
        setNotice(result.data.summary)
        await refreshEvents()
      } else setNotice(result.error.message)
    } catch { setNotice('Provider connection test failed.') }
    finally { setBusyAction(null) }
  }

  async function setActiveProvider(providerId: string | null) {
    setBusyAction('active-provider')
    try {
      const result = await window.workbench.setActiveProvider(providerId)
      if (result.ok) { await refreshProviders(); setNotice(result.data ? `Active provider set to '${result.data.name}'.` : 'Active provider cleared.') }
      else setNotice(result.error.message)
    } catch { setNotice('Could not change active provider.') }
    finally { setBusyAction(null) }
  }

  async function deleteProvider(providerId: string) {
    setBusyAction(`delete-provider:${providerId}`)
    try {
      const result = await window.workbench.deleteProvider(providerId)
      if (result.ok) { await refreshProviders(); setNotice(result.data.deleted ? 'Provider configuration deleted. Revoke the API key with its provider separately if needed.' : 'Provider was not deleted.') }
      else setNotice(result.error.message)
    } catch { setNotice('Could not delete provider configuration.') }
    finally { setBusyAction(null) }
  }

  async function chooseProject() {
    setLoading(true)
    try {
      const result = await window.workbench.chooseProjectRoot()
      if (!result.ok) setNotice(result.error.message)
      else {
        const selected = result.data as ProjectRootSelection
        if (!selected.cancelled && selected.path) {
          setProjectRoot(selected.path)
          setCaseStatus(null)
          await Promise.all([refreshTasks(selected.path), refreshEvidence(selected.path)])
          setNotice('Project folder registered locally. New tasks are persisted, but agent execution remains blocked until a model provider is configured.')
        }
      }
    } catch { setNotice('Could not open the project folder picker.') }
    finally { setLoading(false) }
  }

  async function submitPrompt() {
    const text = prompt.trim()
    if (!text) return
    if (!projectRoot) {
      setNotice('Choose a project folder before starting a task.')
      setActiveArea('projects')
      return
    }
    setBusyAction('create-task')
    try {
      if (selectedMode === 'target-api' && !targetApiAuthorized) {
        setNotice('Confirm that you are authorized to inspect the target API before starting this workflow.')
        return
      }
      if (selectedMode === 'target-api' && !targetApiBaseUrl.trim()) {
        setNotice('Enter an explicit target API base URL. No discovery request will be sent until the scope is reviewed.')
        return
      }
      const result = await window.workbench.createTask({
        projectRoot,
        title: (text.split(/\r?\n/, 1)[0] ?? '').slice(0, 120) || (selectedMode === 'target-api' ? 'Target API investigation' : 'New task'),
        prompt: text,
        mode: selectedMode,
        ...(selectedMode === 'target-api' ? { workflowConfig: { targetApi: {
          baseUrl: targetApiBaseUrl.trim(),
          paths: targetApiPaths.split(/\r?\n/).map(path => path.trim()).filter(Boolean),
          authorizationConfirmed: targetApiAuthorized
        } } } : {})
      })
      if (!result.ok) setNotice(result.error.message)
      else {
        setPrompt('')
        setTasks(previous => [result.data, ...previous.filter(task => task.id !== result.data.id)].slice(0, 200))
        setNotice(result.data.status === 'blocked' ? result.data.summary ?? 'Task saved but blocked.' : 'Task saved locally.')
        await refreshEvents()
      }
    } catch { setNotice('Task could not be saved. The prompt was not sent to a model.') }
    finally { setBusyAction(null) }
  }

  function openRsl(): void {
    setSelectedMode('rsl-investigation')
    setActiveArea('rsl')
  }

  function openProviderDiagnostics(): void {
    setSelectedMode('provider-diagnostics')
    setActiveArea('settings')
  }

  async function cancelTask(taskId: string) {
    setBusyAction(`cancel:${taskId}`)
    try {
      const result = await window.workbench.cancelTask({ taskId })
      if (result.ok && result.data.accepted) setNotice('Task cancelled. Any uncertain side effects must be reconciled before retrying.')
      else if (result.ok) setNotice('Task is not in a cancellable state.')
      else setNotice(result.error.message)
      await Promise.all([refreshTasks(projectRoot), refreshEvents()])
    } catch { setNotice('Task cancellation failed.') }
    finally { setBusyAction(null) }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row"><div className="brand-mark"><Layers3 size={19} /></div><div><div className="brand-name">RSL Workbench</div><div className="brand-sub">AGENT ENGINEERING DESK</div></div><button className="icon-button sidebar-collapse" aria-label="Collapse sidebar"><PanelLeft size={16} /></button></div>
        <button className="project-select" onClick={chooseProject} disabled={loading}><Folder size={16} /><span>{projectRoot ? projectRoot.split(/[\\/]/).filter(Boolean).at(-1) : 'Select a project'}</span><ChevronDown size={14} /></button>
        <nav className="nav-group" aria-label="Main navigation">
          <div className="nav-label">WORKSPACE</div>
          <NavButton icon={<Sparkles size={16}/>} label="Workbench" active={activeArea === 'workbench'} onClick={() => setActiveArea('workbench')} />
          <NavButton icon={<Folder size={16}/>} label="Projects & sessions" active={activeArea === 'projects'} onClick={() => setActiveArea('projects')} />
          <NavButton icon={<Activity size={16}/>} label="Activity & traces" active={activeArea === 'activity'} onClick={() => setActiveArea('activity')} />
          <div className="nav-label second">RSL LIBRARY</div>
          <NavButton icon={<BookOpen size={16}/>} label="Investigation workflows" active={activeArea === 'rsl'} onClick={openRsl} />
          <div className="nav-label second">PREFERENCES</div>
          <NavButton icon={<Settings2 size={16}/>} label="Settings & providers" active={activeArea === 'settings'} onClick={openProviderDiagnostics} />
        </nav>
        <div className="sidebar-bottom">
          <div className="security-card"><div className="security-icon"><ShieldCheck size={16}/></div><div><div className="security-title">Local-first workspace</div><div className="security-text">Credentials are not exposed to the UI.</div></div><CheckCircle2 size={15} className="green" /></div>
          <div className="profile-row"><div className="avatar">RW</div><div className="profile-info"><div className="profile-name">Local workspace</div><div className="profile-role">Autonomous within guardrails</div></div><CircleHelp size={17} className="muted" /></div>
        </div>
      </aside>

      <main className="main-column">
        <header className="topbar"><div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>{pageTitle(activeArea)}</strong></div><div className="topbar-actions"><div className="runtime-pill"><span className={`status-dot ${bootstrap?.runtimeStatus === 'ready' ? 'ready' : 'degraded'}`} />{bootstrap?.runtimeStatus === 'ready' ? 'Core runtime ready' : 'Runtime needs setup'}</div><button className="icon-button" aria-label="Search"><Search size={16}/></button><div className="app-version">{bootstrap ? `v${bootstrap.appVersion}` : 'v0.1.0'}</div></div></header>
        {notice && <div className="notice"><AlertTriangle size={16}/><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss notice">×</button></div>}
        <div className="content-scroll">
          <section className="welcome-block"><div className="eyebrow"><span className="eyebrow-dot"/> DEVELOPMENT BUILD <span className="eyebrow-sep">·</span> RSL v3.1 READY TO WIRE</div><h1>{activeArea === 'workbench' ? <>Research deeply.<br/><span>Act with evidence.</span></> : pageTitle(activeArea)}</h1><p className="welcome-copy">A local-first agent workbench for coding, reverse-engineering investigations and API diagnostics—with policy gates, reproducible evidence and resumable tasks.</p></section>

          <section className="feature-grid" aria-label="Workbench workflows">
            <FeatureCard icon={<Code2 size={17}/>} title="Coding agent" tag="CORE RUNTIME" description="Plan changes, inspect code and run bounded tools through one policy-controlled task loop." onClick={() => setActiveArea('workbench')}/>
            <FeatureCard icon={<Workflow size={17}/>} title="RSL investigation" tag="EVIDENCE-GATED" description="Detect capabilities, check prior art, route to specialist modules and preserve evidence." onClick={openRsl}/>
            <FeatureCard icon={<TerminalSquare size={17}/>} title="API diagnostics" tag="TWO WORKFLOWS" description="Investigate authorized target APIs or diagnose configured model-provider endpoints." onClick={openProviderDiagnostics}/>
          </section>

          {approvals.length > 0 && <section className="approval-queue-panel" aria-live="polite"><div className="integration-panel-heading"><div><div className="section-kicker">EXACT-ACTION GATE</div><h2>Pending approvals ({approvals.length})</h2></div><button className="text-button" onClick={() => void refreshApprovals()}>Refresh</button></div><p className="approval-explainer">Review each command or file change. Approval applies only to the shown parameters and expires automatically.</p>{approvals.slice(0, 8).map(approval => <article className="approval-card" key={approval.id}><div className="approval-card-head"><strong>{approval.summary}</strong><span className="task-status waiting_approval">REVIEW</span></div><div className="approval-facts"><div><span>Target</span><code>{approval.target}</code></div><div><span>Reason</span><p>{approval.reason}</p></div><div><span>Expected impact</span><p>{approval.expectedImpact}</p></div>{approval.rollbackInfo && <div><span>Rollback</span><p>{approval.rollbackInfo}</p></div>}{approval.actionDetails && <div><span>Exact proposed file content (secret-redacted)</span><pre className="approval-details">{approval.actionDetails}</pre></div>}<small>Expires {new Date(approval.expiresAt).toLocaleString()} · task {approval.taskId.slice(0, 8)}</small></div><div className="integration-actions"><button className="primary-button" onClick={() => void decideApproval(approval.id, 'approve')} disabled={busyAction !== null}>{busyAction === `approval:${approval.id}` ? 'Recording…' : 'Approve exact action'}</button><button className="secondary-button" onClick={() => void decideApproval(approval.id, 'deny')} disabled={busyAction !== null}>Deny</button></div></article>)}</section>}

          <section className="work-area">
            <div className="work-area-main">
              <div className="section-heading"><div><div className="section-kicker">START A SESSION</div><h2>What are we working on?</h2></div><span className="safe-tag"><LockKeyhole size={13}/> Scoped execution</span></div>
              <div className="composer-card"><div className="composer-top"><label className="mode-selector"><Bot size={15}/><select aria-label="Task mode" value={selectedMode} onChange={event => setSelectedMode(event.target.value as TaskSummary['mode'])}><option value="coding">Coding agent</option><option value="rsl-investigation">RSL investigation</option><option value="target-api">Target API investigation</option><option value="provider-diagnostics">Model provider diagnostics</option></select><ChevronDown size={13}/></label><span className="composer-hint">{providers.some(provider => provider.active) ? 'Model route configured · writes and commands require approval' : 'No model route configured'}</span></div><textarea aria-label="Task prompt" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Describe the change or investigation. RSL will detect capabilities and select the required workflow before tools run…" rows={4}/>{selectedMode === 'target-api' && <div className="target-api-scope"><div className="target-api-scope-title"><ShieldCheck size={14}/> EXPLICIT TARGET API SCOPE</div><label>Base URL<input aria-label="Target API base URL" value={targetApiBaseUrl} onChange={event => setTargetApiBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" autoComplete="off" spellCheck={false}/></label><label>Relative paths (one per line; leave empty to request the base path)<textarea aria-label="Target API paths" value={targetApiPaths} onChange={event => setTargetApiPaths(event.target.value)} placeholder={"openapi.json\nhealth"} rows={3} spellCheck={false}/></label><label className="target-api-consent"><input type="checkbox" checked={targetApiAuthorized} onChange={event => setTargetApiAuthorized(event.target.checked)}/> I am authorized to inspect this API and understand that only the listed unauthenticated GET requests will be sent.</label><p>No credentials, cookies, mutation verbs, redirects, fuzzing or automatic crawling. A second native confirmation will show the exact destination and paths before requests begin.</p></div>}<div className="composer-bottom"><div className="composer-chips"><span><GitBranch size={13}/> Plans</span><span><ShieldCheck size={13}/> Approvals</span><span><Activity size={13}/> Evidence</span>{projectRoot && <button className="text-button compact-action" onClick={inspectEvidence} disabled={busyAction !== null}>Inspect file</button>}</div><button className="primary-button" onClick={submitPrompt} disabled={!prompt.trim() || busyAction !== null}>{busyAction === 'create-task' ? 'Saving…' : 'Start task'} <ArrowUpRight size={15}/></button></div></div>
              <div className="section-heading task-heading"><div><div className="section-kicker">SESSION OVERVIEW</div><h2>Recent work</h2></div><button className="text-button" onClick={() => setActiveArea('activity')}>View activity <ArrowUpRight size={13}/></button></div>
              {activeArea === 'rsl' && <div className="integration-panel"><div className="integration-panel-heading"><div><div className="section-kicker">BUNDLED WORKFLOW SPECIFICATION</div><h3>RSL {rslStatus?.version ?? bootstrap?.rslVersion ?? '3.1'}</h3></div><span className={`result-chip ${rslStatus?.passed ? 'pass' : rslStatus ? 'fail' : ''}`}>{rslStatus?.passed ? 'VALIDATED' : rslStatus ? 'CHECK FAILED' : 'CHECKING'}</span></div><p>{rslStatus?.summary ?? 'Validating the bundled RSL package…'}</p><div className="integration-actions"><button className="secondary-button" onClick={validateRsl} disabled={busyAction !== null}>{busyAction === 'validate-rsl' ? 'Validating…' : 'Re-run package validation'}</button><button className="primary-button" onClick={validateCase} disabled={!projectRoot || busyAction !== null}>{busyAction === 'validate-case' ? 'Validating…' : 'Validate project case'}</button><button className="secondary-button" onClick={initializeCase} disabled={!projectRoot || busyAction !== null}>{busyAction === 'initialize-case' ? 'Creating…' : 'Initialize case folder'}</button></div><div className="export-row"><label>Harness profile<select value={selectedHarness} onChange={event => setSelectedHarness(event.target.value as RslHarnessId)} aria-label="Harness profile">{(['claude-code','cursor','codex','gemini-cli','copilot','opencode','cline','windsurf','grok-build','generic'] as RslHarnessId[]).map(harness => <option key={harness} value={harness}>{harness}</option>)}</select></label><button className="secondary-button" onClick={exportRslSkill} disabled={busyAction !== null}>{busyAction === 'export-rsl' ? 'Exporting…' : 'Export portable skill'}</button></div>{caseInitStatus && <div className="detail-line">{caseInitStatus.summary}</div>}{exportResult && <div className={`case-result ${exportResult.exported ? 'pass' : 'fail'}`}><strong>{exportResult.summary}</strong>{exportResult.details.map((detail, index) => <p key={`${index}-${detail}`}>{detail}</p>)}</div>}{caseStatus && <div className={`case-result ${caseStatus.passed ? 'pass' : 'fail'}`}><strong>{caseStatus.summary}</strong>{caseStatus.errors.slice(0, 8).map((error, index) => <p key={`${index}-${error}`}>{error}</p>)}</div>}{rslStatus?.details.map((detail, index) => <div className="detail-line" key={`${index}-${detail}`}>{detail}</div>)}</div>}
              {activeArea === 'settings' && <div className="provider-settings">
                <div className="integration-panel"><div className="integration-panel-heading"><div><div className="section-kicker">PROVIDER-NEUTRAL ADAPTER</div><h3>Model endpoints & diagnostics</h3></div><span className="result-chip">NO AUTO-FALLBACK</span></div><p>Supports OpenAI-compatible /models discovery for local and cloud endpoints. Saving a cloud endpoint requires native confirmation; testing is an explicit outbound request. API keys are encrypted by Electron safeStorage and are never returned to the UI or logged.</p>
                  <div className="provider-form-grid">
                    <label>Provider name<input value={providerName} onChange={e => setProviderName(e.target.value)} maxLength={100} placeholder="Local model" /></label>
                    <label>Endpoint type<select value={providerKind} onChange={e => { const next = e.target.value as ProviderKind; setProviderKind(next); if (!editingProviderId) { setProviderBaseUrl(next === 'local' ? 'http://127.0.0.1:11434/v1' : 'https://api.openai.com/v1'); setProviderName(next === 'local' ? 'Local OpenAI-compatible' : 'Cloud OpenAI-compatible'); setProviderModel(next === 'local' ? 'qwen2.5-coder' : 'gpt-4.1-mini') } }}><option value="local">Local model (loopback only)</option><option value="cloud">Cloud provider (HTTPS)</option></select></label>
                    <label className="wide-label">Base URL<input value={providerBaseUrl} onChange={e => setProviderBaseUrl(e.target.value)} maxLength={2048} placeholder="http://127.0.0.1:11434/v1" spellCheck={false}/></label>
                    <label>Model identifier<input value={providerModel} onChange={e => setProviderModel(e.target.value)} maxLength={200} placeholder="model-id" spellCheck={false}/></label>
                    <label>API key<input value={providerApiKey} onChange={e => setProviderApiKey(e.target.value)} type="password" autoComplete="new-password" maxLength={16384} placeholder={editingProviderId ? 'Leave blank to keep saved key' : 'Optional for local; required for many cloud APIs'}/></label>
                  </div>
                  {editingProviderId && <label className="provider-check"><input type="checkbox" checked={clearProviderKey} onChange={e => setClearProviderKey(e.target.checked)}/> Remove saved credential from this provider</label>}
                  <div className="integration-actions"><button className="primary-button" onClick={saveProvider} disabled={busyAction !== null}>{busyAction === 'save-provider' ? 'Saving…' : editingProviderId ? 'Update provider' : 'Save provider'}</button>{editingProviderId && <button className="secondary-button" onClick={prepareNewProvider} disabled={busyAction !== null}>Cancel edit</button>}</div>
                  <div className="detail-line">Security: local endpoints must use loopback. Cloud endpoints require HTTPS and public DNS resolution. Redirects are not followed, diagnostic responses are capped at 1 MB, and diagnostic requests do not send prompts.</div>
                </div>
                <div className="integration-panel"><div className="integration-panel-heading"><div><div className="section-kicker">CONFIGURED ROUTES</div><h3>{providers.length} provider{providers.length === 1 ? '' : 's'} configured</h3></div><button className="text-button" onClick={() => void refreshProviders()}>Refresh</button></div>
                  {providers.length === 0 ? <p>No provider saved yet. Start with a local OpenAI-compatible endpoint if you have a local inference server running.</p> : <div className="provider-list">{providers.map(provider => { const diagnostic = providerDiagnostics[provider.id]; return <article className="provider-card" key={provider.id}><div className="provider-card-main"><div className="provider-name-line"><strong>{provider.name}</strong>{provider.active && <span className="result-chip pass">ACTIVE</span>}<span className="provider-kind">{provider.kind}</span></div><p>{provider.baseUrl}</p><div className="task-meta"><span>Model: {provider.model}</span><span>{provider.hasCredentials ? 'Encrypted credential saved' : 'No credential saved'}</span><span>{diagnostic ? `${diagnostic.latencyMs} ms` : 'Not tested'}</span></div>{diagnostic && <div className={`case-result ${diagnostic.ok ? 'pass' : 'fail'}`}><strong>{diagnostic.summary}</strong>{diagnostic.details.map((detail, i) => <p key={`${i}-${detail}`}>{detail}</p>)}{diagnostic.models.length > 0 && <p>Models: {diagnostic.models.map(model => model.id).join(', ')}</p>}</div>}</div><div className="provider-actions"><button className="secondary-button" onClick={() => testProvider(provider.id)} disabled={busyAction !== null}>{busyAction === `test-provider:${provider.id}` ? 'Testing…' : 'Test connection'}</button>{!provider.active && <button className="secondary-button" onClick={() => setActiveProvider(provider.id)} disabled={busyAction !== null}>Set active</button>}{provider.active && <button className="secondary-button" onClick={() => setActiveProvider(null)} disabled={busyAction !== null}>Clear active</button>}<button className="text-button" onClick={() => editProvider(provider)}>Edit</button><button className="text-button danger-text" onClick={() => deleteProvider(provider.id)} disabled={busyAction !== null}>Delete</button></div></article> })}</div>}
                  <div className="detail-line">An active route enables bounded coding-agent runs. Provider diagnostics are separate from task inference. Cloud fallback requires a separate explicit user decision and is never silent.</div>
                </div>
              </div>}
              {activeArea === 'activity' && <div className="integration-panel"><div className="integration-panel-heading"><div><div className="section-kicker">LOCAL AUDIT TRAIL</div><h3>Recent activity</h3></div><button className="text-button" onClick={refreshEvents}>Refresh <ArrowUpRight size={13}/></button></div>{events.length === 0 ? <p>No activity has been recorded yet.</p> : <div className="event-list">{events.slice(0, 40).map(item => <div className="event-row" key={item.id}><span className={`event-marker ${item.kind}`}/><div className="event-content"><strong>{item.title}</strong><p>{item.detail ?? ''}</p><small>{new Date(item.at).toLocaleString()} {item.taskId ? `· ${item.taskId.slice(0, 8)}` : ''}</small></div></div>)}</div>}</div>}
              {tasks.length === 0 ? <div className="empty-state"><div className="empty-graphic"><Activity size={21}/></div><div className="empty-title">No tasks recorded yet</div><p>Select a project and start a task. Prompts are secret-redacted before persistence; coding execution requires an active provider, while investigation modes remain gated.</p></div> : <div className="task-list">{tasks.slice(0, 30).map(task => <article className="task-card" key={task.id}><div className="task-card-main"><div className="task-title-row"><strong>{task.title}</strong><span className={`task-status ${task.status}`}>{task.status.replaceAll('_', ' ')}</span></div><p>{task.summary ?? 'No summary recorded.'}</p><div className="task-meta"><span>{task.mode.replaceAll('-', ' ')}</span><span>{new Date(task.updatedAt).toLocaleString()}</span><span>checkpoint v{task.checkpointVersion}</span></div></div><div className="task-action-column">{['interrupted','blocked'].includes(task.status) && task.mode === 'coding' && <button className="secondary-button" onClick={() => resumeTask(task.id)} disabled={busyAction !== null || !providers.some(provider => provider.active)}>{busyAction === `resume:${task.id}` ? 'Resuming…' : 'Resume'}</button>}{['queued','running','waiting_approval','blocked','interrupted'].includes(task.status) && <button className="task-cancel" onClick={() => cancelTask(task.id)} disabled={busyAction !== null}>{busyAction === `cancel:${task.id}` ? 'Cancelling…' : 'Cancel'}</button>}</div></article>)}</div>}
              {activeArea !== 'activity' && activeArea !== 'rsl' && projectRoot && evidence.length > 0 && <div className="evidence-panel"><div className="section-heading"><div><div className="section-kicker">INTEGRITY-RECORDED FILES</div><h2>Evidence artifacts</h2></div><button className="text-button" onClick={() => refreshEvidence(projectRoot)}>Refresh</button></div>{evidence.slice(0, 10).map(item => <div className="evidence-row" key={item.id}><div><strong>{item.relativePath}</strong><small>{item.sizeBytes.toLocaleString()} bytes · {item.createdAt}</small></div><code>{item.sha256.slice(0, 18)}…</code></div>)}</div>}
            </div>
            <aside className="work-area-side"><div className="side-panel"><div className="side-panel-heading"><span>RUNTIME STATUS</span><span className="live-dot"/></div><div className="runtime-row"><span className="runtime-indicator warn"/><div><strong>Browser UI</strong><small>Vite renderer loaded</small></div><span className="mini-status">DEV</span></div><div className="runtime-row"><span className="runtime-indicator"/><div><strong>Task records</strong><small>Browser localStorage</small></div><span className="mini-status">LOCAL</span></div><div className="runtime-row"><span className={`runtime-indicator ${rslStatus?.passed ? '' : 'warn'}`}/><div><strong>RSL library</strong><small>{rslStatus?.passed ? 'Package validator passed' : 'Validation required'}</small></div><span className={`mini-status ${rslStatus?.passed ? '' : 'muted-mini'}`}>{rslStatus?.passed ? 'PASS' : 'CHECK'}</span></div><div className="runtime-row"><span className="runtime-indicator"/><div><strong>Backend workers</strong><small>Requires secure backend</small></div><span className="mini-status">LOCAL</span></div><div className="runtime-row"><span className={`runtime-indicator ${providers.some(provider => provider.active) ? '' : 'muted-dot'}`}/><div><strong>Model adapters</strong><small>{providers.some(provider => provider.active) ? 'Active route configured; verify connectivity in Settings' : 'Provider setup required'}</small></div><span className={`mini-status ${providers.some(provider => provider.active) ? '' : 'muted-mini'}`}>{providers.some(provider => provider.active) ? 'CONFIGURED' : 'SETUP'}</span></div></div>
              <div className="side-panel"><div className="side-panel-heading">GUARDRAILS <ShieldCheck size={14}/></div><div className="guardrail-row"><CheckCircle2 size={15}/><span>Browser sandbox</span></div><div className="guardrail-row"><CheckCircle2 size={15}/><span>Backend API allowlist</span></div><div className="guardrail-row"><CheckCircle2 size={15}/><span>No local command access</span></div><div className="guardrail-row"><Clock3 size={15}/><span>Backend approvals required</span><span className="pending-dot"/></div></div>
              <div className="side-panel rsl-panel"><div className="rsl-logo"><BookOpen size={16}/><span>REVERSE SKILL LIBRARY</span></div><h3>Evidence before claims.</h3><p>Bundled RSL version {bootstrap?.rslVersion ?? '3.1'} · {rslStatus?.passed ? 'validation passed' : 'validation not yet passed'}.</p><button className="text-button" onClick={() => setActiveArea('rsl')}>Inspect RSL status <ArrowUpRight size={13}/></button></div>
            </aside>
          </section>
          <footer className="footer"><span><span className="footer-dot"/> Browser preview · no task execution backend</span><span>Designed for bounded autonomy.</span></footer>
        </div>
      </main>
    </div>
  )
}

function pageTitle(area: Area): string {
  return ({ workbench: 'Workbench', projects: 'Projects & sessions', activity: 'Activity & traces', rsl: 'Investigation workflows', settings: 'Settings & providers' })[area]
}

function NavButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{active && <span className="active-rail"/>}</button>
}

function FeatureCard({ icon, title, tag, description, onClick }: { icon: React.ReactNode; title: string; tag: string; description: string; onClick: () => void }) {
  return <button className="feature-card" onClick={onClick}><div className="feature-card-top"><span className="feature-icon">{icon}</span><span className="feature-tag">{tag}</span></div><div className="feature-title">{title}</div><p>{description}</p><div className="feature-arrow"><Plus size={14}/></div></button>
}
