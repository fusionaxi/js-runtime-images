// @nodevu/core does not ship TypeScript declarations. Validate its output at runtime.
declare module '@nodevu/core' {
  export default function nodevu(options?: {
    fetch?: (url: string) => Promise<{ json(): Promise<unknown> }>
    now?: string
    urls?: { index?: string; schedule?: string }
  }): Promise<unknown>
}
