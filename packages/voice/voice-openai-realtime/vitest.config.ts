import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { fileURLToPath } from 'node:url'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  resolve: {
    alias: {
      '@deepseek-ai/dsh-voice': fileURLToPath(new URL('../voice/src/index.ts', import.meta.url)),
    },
  },
  test: {
    pool: 'forks',
    execArgv: vitestExecArgv,
    include: ['packages/voice/voice-openai-realtime/tests/**/*.spec.ts'],
  },
})
