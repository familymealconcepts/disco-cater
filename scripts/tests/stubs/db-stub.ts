// Test stand-in for lib/db.ts. Every query goes to globalThis.__sqlHandler, which a
// test sets per scenario; nothing ever reaches Neon. Used by guard tests that run a
// real route module outside Next (see scripts/tests/fm-password-signin.test.ts).
type Handler = (text: string, params: unknown[]) => unknown[]
const g = globalThis as unknown as { __sqlHandler?: Handler }
function run(text: string, params: unknown[]): Promise<unknown[]> {
  if (!g.__sqlHandler) return Promise.reject(new Error('db-stub: no handler set'))
  try { return Promise.resolve(g.__sqlHandler(text, params)) } catch (e) { return Promise.reject(e) }
}
export const sql = Object.assign(
  (strings: TemplateStringsArray, ...params: unknown[]) => run(strings.join('$?'), params),
  { query: (text: string, params: unknown[] = []) => run(text, params) },
)
export async function runDiscoOrderMigrations(): Promise<void> {}
export async function runMigrations(): Promise<void> {}
export async function withDiscoTables<T>(fn: () => Promise<T>): Promise<T> { return fn() }
