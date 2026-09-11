declare module "import-in-the-middle/register-hooks.mjs" {
  export interface RegisterHooksOptions {
    include?: Array<string | RegExp>
    exclude?: Array<string | RegExp>
    disableCjsSourceStripping?: boolean
  }
  export function register(options?: RegisterHooksOptions): void
  export function supportsSyncHooks(): boolean
}