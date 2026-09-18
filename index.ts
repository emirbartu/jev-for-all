import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "system-one",
  setup(ctx) {
    // Register transforms (ctx.tool, ctx.command, ctx.agent, ...) or hooks
    // (ctx.session.hook, ctx.tool.hook, ...) here. Read options via ctx.options.
    //
    // Return a cleanup function to release resources when the plugin unloads:
    // return () => clearInterval(timer)
  },
})
