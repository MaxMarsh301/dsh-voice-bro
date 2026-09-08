/** Narrow DSH integration additions accompanying the four global-voice packages. */
export const externalIntegrationPatches = [
  {
    path: 'packages/api/remotes/src/client/index.ts',
    before: "export type {} from '@deepseek-ai/dsh-voice/remote'\n",
    after: "export type {} from '@deepseek-ai/dsh-voice/remote'\nexport type {} from '@deepseek-ai/dsh-voice/types'\n",
  },
  {
    path: 'packages/api/remotes/src/index.ts',
    before: "import type {} from '@deepseek-ai/dsh-settings/types'\n",
    after: "import type {} from '@deepseek-ai/dsh-settings/types'\nimport type {} from '@deepseek-ai/dsh-voice/types'\n",
  },
  {
    path: 'packages/api/remotes/src/remote-events.ts',
    before: '/**\n * The one home of this application',
    after: "import type {} from '@deepseek-ai/dsh-voice/types'\n\n/**\n * The one home of this application",
  },
  {
    path: 'packages/api/remotes/src/remote-events.ts',
    before: "  'settings/document-updated',\n",
    after: "  'settings/document-updated',\n  'voice/navigation-requested',\n  'voice/creation-requested',\n  'voice/completion-requested',\n",
  },
  {
    path: 'packages/api/remotes/tsconfig.host.json',
    before: '    {\n      "path": "../../typert/protocol"\n    }\n',
    after: '    {\n      "path": "../../typert/protocol"\n    },\n    {\n      "path": "../../voice/voice"\n    }\n',
  },
  {
    path: 'packages/host/apiproxy/src/api-proxy.ts',
    before: "import type {} from '@deepseek-ai/dsh-tools'\n",
    after: "import type {} from '@deepseek-ai/dsh-tools'\nimport type {} from '@deepseek-ai/dsh-voice/types'\n",
  },
  {
    path: 'packages/host/apiproxy/package.json',
    before: '    "@deepseek-ai/dsh-user-questions": "workspace:^",\n',
    after: '    "@deepseek-ai/dsh-user-questions": "workspace:^",\n    "@deepseek-ai/dsh-voice": "workspace:^",\n',
  },
  {
    path: 'packages/host/apiproxy/tsconfig.json',
    before: '    {\n      "path": "../../util/native-command"\n    }\n',
    after: '    {\n      "path": "../../util/native-command"\n    },\n    {\n      "path": "../../voice/voice"\n    }\n',
  },
  {
    path: 'packages/client/runtime/src/client/contract/workspaces.ts',
    before: '  connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>\n',
    after: `  connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>
  /**
   * Create a fresh Session in the explicit, current, or recent Workspace without navigating.
   * @param workspaceId - explicit target; omitted inherits the current Session Workspace, then recency.
   * @returns the fresh Session id after it is addressable in the Session list.
   */
  createSession(workspaceId?: WorkspaceId): Promise<SessionId>
`,
  },
  {
    path: 'packages/client/runtime/src/client/workspaces/service.ts',
    before: '  /**\n   * Follow the first complete Workspace/Session baseline and select a default\n',
    after: `  /** Create a fresh Session in a trusted Workspace selected from current client state. */
  async createSession(workspaceId?: WorkspaceId): Promise<SessionId> {
    const workspace = this.list.getSnapshot()
    const current = this.sessions.list.getSnapshot().current
    const currentWorkspaceId = current === undefined
      ? undefined
      : workspace.items.find(item => item.sessionIds.includes(current))?.workspaceId
    const target = workspaceId ?? currentWorkspaceId ?? workspace.recentWorkspaceId
    if (target === undefined || !workspace.items.some(item => item.workspaceId === target)) {
      throw new Error('workspaces.createSession: no accessible workspace')
    }
    return this.sessions.create({ workspaceId: target })
  }

  /**
   * Follow the first complete Workspace/Session baseline and select a default
`,
  },
  {
    path: 'packages/test-support/client-runtime/src/workspaces.ts',
    before: '  /**\n   * New-session flow (recorded; stubbed behavior runs when installed).\n',
    after: `  /** Create a fresh session in a selected Workspace (recorded). */
  async createSession(workspaceId?: WorkspaceId): Promise<SessionId> {
    this.calls.push({ method: 'createSession', args: [workspaceId] })
    const stub = this.stubs.get('createSession')
    if (stub !== undefined) return await (stub(workspaceId) as Promise<SessionId>)
    return \`fresh-session-of-\${workspaceId ?? 'recent'}\` as SessionId
  }

  /**
   * New-session flow (recorded; stubbed behavior runs when installed).
`,
  },
  {
    path: 'packages/client/runtime/tests/workspaces-service.client.spec.ts',
    before: "  it('a rejected first prompt keeps the blank session eligible for connectWorkspace reuse', async () => {\n",
    after: `  it('createSession always mints a fresh Session in the explicit or current trusted Workspace', async () => {
    const ctx = new Context(); const api = new FakeApiClient()
    const sessions = new SessionRuntime(ctx, api, fakeRemote())
    const workspaces = new WorkspaceRuntime(ctx, api, sessions)
    api.onWorkspaceList = () => Promise.resolve(ok({ items: [workspace('alpha', [sid('current')]), workspace('beta')] as never[] }))
    api.onList = () => Promise.resolve(ok({ items: [{ sessionId: sid('current'), updatedAt: 2, running: false, blank: true, cwd: '/w/alpha' }] as never[] }))
    await Promise.all([workspaces.refresh(), sessions.refresh()]); sessions.open(sid('current'))

    api.onCreate = payload => Promise.resolve(ok({ sessionId: sid((payload as { workspaceId?: string }).workspaceId === 'beta' ? 'fresh-beta' : 'fresh-alpha') }))
    await expect(workspaces.createSession()).resolves.toBe('fresh-alpha')
    await expect(workspaces.createSession(wid('beta'))).resolves.toBe('fresh-beta')
    expect(api.callsOf('session.create')).toEqual([{ workspaceId: 'alpha' }, { workspaceId: 'beta' }])
    await expect(workspaces.createSession(wid('ghost'))).rejects.toThrow(/no accessible workspace/)
  })

  it('a rejected first prompt keeps the blank session eligible for connectWorkspace reuse', async () => {
`,
  },
]
