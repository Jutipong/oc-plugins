/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createAuthManager } from "./auth.mjs"
import { resolveCommand } from "./commands.mjs"
import { createLogger } from "./log.mjs"
import { buildDetailLines } from "./model.mjs"
import { openBrowser } from "./open.mjs"
import { resolveOptions } from "./options.mjs"
import { createUsageService } from "./service.mjs"
import { normalizeStatus } from "./status.mjs"
import { createObservable } from "./store.mjs"
import { createSpeedTracker } from "./tps.mjs"
import { PromptUsage } from "./ui/line.tsx"

const NO_FETCH = () => Promise.reject(new Error("fetch unavailable"))

export default Plugin.define({
  id: "go-usage",
  setup(context) {
    const env = globalThis.process?.env ?? {}
    const options = resolveOptions({ options: context.options ?? {}, env })
    const log = createLogger(options.debug)
    const userAgent = `opencode/${context.app?.version ?? "2.0"} (go-usage)`
    const fetchImpl = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null

    log.write(`setup interval=${options.intervalSeconds}s base=${options.baseUrl} tps=${options.tps}`)

    const [authDoc, updateAuthDoc] = context.storage.store("auth", {
      initial: { access: null, refresh: null, expiresAt: 0, orgId: null },
    })
    const [cacheDoc, updateCacheDoc] = context.storage.store("cache", {
      initial: { payload: null, fetchedAt: 0 },
    })

    const readAuthDoc = () => ({
      access: authDoc.access ?? null,
      refresh: authDoc.refresh ?? null,
      expiresAt: authDoc.expiresAt ?? 0,
      orgId: authDoc.orgId ?? null,
    })

    const auth = createAuthManager({
      fetchImpl: fetchImpl ?? NO_FETCH,
      baseUrl: options.baseUrl,
      userAgent,
      initial: readAuthDoc(),
      persist: (next) => {
        void updateAuthDoc((draft) => {
          draft.access = next?.access ?? null
          draft.refresh = next?.refresh ?? null
          draft.expiresAt = next?.expiresAt ?? 0
          draft.orgId = next?.orgId ?? null
        })
      },
    })

    const service = createUsageService({
      fetchImpl: fetchImpl ?? NO_FETCH,
      baseUrl: options.baseUrl,
      userAgent,
      auth,
      orgId: options.orgId,
    })

    const cachedPayload = cacheDoc.payload ?? null
    const cachedAt = Number(cacheDoc.fetchedAt) || 0
    const initialView = auth.connected
      ? cachedPayload
        ? { phase: "ready", status: normalizeStatus(cachedPayload, cachedAt), stale: false, fetchedAt: cachedAt, error: null }
        : cachedAt > 0
          ? { phase: "absent", status: null, stale: false, fetchedAt: cachedAt, error: null }
          : { phase: "loading", status: null, stale: false, fetchedAt: 0, error: null }
      : { phase: "checking", status: null, stale: false, fetchedAt: 0, error: null }
    const state = createObservable(initialView)
    // `{ [sessionID]: tokensPerSecond }` for sessions that are streaming now.
    const speeds = createObservable({})

    let inFlight = null
    let loginTask = null
    let disposed = false
    // Bumped on logout so an in-flight login cannot resurrect the session.
    let loginEpoch = 0
    // After logout, ignore any auth document that has not been cleared yet.
    let suppressAdopt = false

    const toast = (variant, message, duration = 2500) => {
      try {
        context.ui.toast.show({ message, variant, duration })
      } catch {
        // Toasts are best-effort.
      }
    }

    async function refresh({ manual = false } = {}) {
      if (disposed) return null
      if (!suppressAdopt) auth.adopt(readAuthDoc())
      if (!auth.connected) {
        state.set({ phase: "checking", status: null, stale: false, fetchedAt: 0, error: null })
        return null
      }
      if (!fetchImpl) {
        state.set({ phase: "error", status: null, stale: false, fetchedAt: 0, error: "no fetch runtime" })
        return null
      }
      if (inFlight) return inFlight
      inFlight = (async () => {
        const outcome = await service.fetchStatus()
        const suffix = outcome.status ? ` (${outcome.status})` : outcome.message ? ` ${outcome.message}` : ""
        log.write(`fetch -> ${outcome.kind}${suffix}`)
        if (outcome.kind === "ok") {
          const fetchedAt = Date.now()
          const status = normalizeStatus(outcome.payload, fetchedAt)
          state.set({ phase: "ready", status, stale: false, fetchedAt, error: null })
          void updateCacheDoc((draft) => {
            draft.payload = outcome.payload
            draft.fetchedAt = fetchedAt
          })
          if (manual) toast("success", `Go usage updated · ${status.plan}`)
          return status
        }
        if (outcome.kind === "absent") {
          const fetchedAt = Date.now()
          state.set({ phase: "absent", status: null, stale: false, fetchedAt, error: null })
          void updateCacheDoc((draft) => {
            draft.payload = null
            draft.fetchedAt = fetchedAt
          })
          if (manual) toast("info", "No active OpenCode Go subscription")
          return null
        }
        if (outcome.kind === "disconnected") {
          state.set({ phase: "checking", status: null, stale: false, fetchedAt: 0, error: null })
          return null
        }
        if (outcome.kind === "unauthorized") {
          state.set({ phase: "disconnected", status: null, stale: false, fetchedAt: 0, error: "session expired" })
          if (manual) toast("error", "Console session expired — run /go-usage login", 3500)
          return null
        }
        const message = outcome.message ?? (outcome.status ? `HTTP ${outcome.status}` : "network error")
        const previous = state.get()
        if (previous.status) state.set({ ...previous, stale: true, error: message })
        else state.set({ phase: "error", status: null, stale: false, fetchedAt: 0, error: message })
        if (manual) toast("error", `Go usage fetch failed (${message})`, 3500)
        return null
      })().finally(() => {
        inFlight = null
      })
      return inFlight
    }

    async function showDetails() {
      const lines = buildDetailLines({ ...state.get(), now: Date.now() })
      try {
        await context.ui.dialog.alert({ title: "OpenCode Go usage", message: lines.join("\n") })
      } catch (error) {
        log.write(`detail dialog failed: ${error?.message ?? error}`)
      }
    }

    function logout() {
      loginEpoch += 1
      suppressAdopt = true
      auth.logout()
      state.set({ phase: "checking", status: null, stale: false, fetchedAt: 0, error: null })
      void updateCacheDoc((draft) => {
        draft.payload = null
        draft.fetchedAt = 0
      })
      toast("info", "Disconnected from OpenCode Go")
    }

    function loginFailure(result) {
      switch (result?.kind) {
        case "expired":
          return "The login code expired — run /go-usage login again"
        case "denied":
          return "Login denied in the browser"
        case "invalid":
          return "Login was rejected — run /go-usage login again"
        default:
          return result?.status ? `Login failed (HTTP ${result.status})` : "Login failed — check your network"
      }
    }

    async function login() {
      if (loginTask) return loginTask
      if (!fetchImpl) {
        toast("error", "Network is unavailable in this runtime")
        return null
      }
      const epoch = loginEpoch
      loginTask = (async () => {
        let started
        try {
          started = await auth.beginLogin()
        } catch (error) {
          log.write(`begin login failed: ${error?.message ?? error}`)
          started = { kind: "error" }
        }
        if (started.kind !== "ok") {
          toast("error", "Could not start login — check your network", 3500)
          return null
        }
        const flow = started.flow
        log.write(`device login started (${flow.userCode})`)
        openBrowser(flow.url, options.openBrowser, log)

        let completed = false
        let cancelled = false
        void context.ui.dialog
          .alert({
            title: "Connect OpenCode Go",
            message: [
              "Approve this code in your browser:",
              "",
              flow.userCode,
              "",
              flow.url,
              "",
              "Waiting for approval…",
            ].join("\n"),
          })
          .then(() => {
            if (!completed) cancelled = true
          })

        let result
        try {
          result = await auth.completeLogin(flow, {
            shouldCancel: () => cancelled || disposed || loginEpoch !== epoch,
          })
        } catch (error) {
          log.write(`login poll failed: ${error?.message ?? error}`)
          result = { kind: "error", message: error?.message }
        }
        completed = true
        try {
          context.ui.dialog.clear()
        } catch {
          // Dialog may already be gone.
        }

        if (result.kind === "ok") {
          suppressAdopt = false
          toast("success", "Connected to OpenCode Go")
          await refresh()
        } else if (result.kind === "cancelled") {
          toast("info", "Login cancelled")
        } else {
          toast("error", loginFailure(result), 4000)
        }
        return null
      })().finally(() => {
        loginTask = null
      })
      return loginTask
    }

    /**
     * Login entry point: don't start a second flow when connected, unless the
     * Console session is known to be expired (that is what login is for).
     */
    function loginCommand() {
      if (auth.connected && state.get().phase !== "disconnected") {
        toast("info", "Already connected — use /go-usage-logout to disconnect")
        return null
      }
      return login()
    }

    async function handleCommand(input) {
      const action = resolveCommand(input, state.get().phase)
      if (action === "login") return loginCommand()
      if (action === "logout") return logout()
      if (action === "refresh") return refresh({ manual: true })
      if (action === "details") return showDetails()
      const command = String(input ?? "").trim().split(/\s+/)[0]
      toast("warning", `Unknown /go-usage option "${command}" — use refresh or logout`, 3500)
      return null
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "go-usage.show",
          title: "Go usage",
          description: "Show OpenCode Go usage details, or connect when signed out",
          group: "Go usage",
          palette: true,
          slash: { name: "go-usage", arguments: true },
          run: (input) => handleCommand(input),
        },
        {
          id: "go-usage.refresh",
          title: "Go usage: refresh",
          description: "Fetch the latest OpenCode Go meters (/go-usage-refresh)",
          group: "Go usage",
          palette: true,
          slash: { name: "go-usage-refresh" },
          run: () => refresh({ manual: true }),
        },
        {
          id: "go-usage.login",
          title: "Go usage: connect",
          description: "Sign in to your OpenCode Console account (/go-usage-login)",
          group: "Go usage",
          palette: true,
          slash: { name: "go-usage-login" },
          run: () => loginCommand(),
        },
        {
          id: "go-usage.logout",
          title: "Go usage: disconnect",
          description: "Forget the stored Console session (/go-usage-logout)",
          group: "Go usage",
          palette: true,
          slash: { name: "go-usage-logout" },
          run: () => logout(),
        },
      ],
    }))

    const disposers = []

    // Live output speed: the runtime streams text/reasoning deltas but no
    // token counters until a step ends, so the tracker estimates tokens per
    // second from delta characters (see tps.mjs). Published at most twice a
    // second, and only when the visible value changes.
    if (options.tps && typeof context.data?.listen === "function") {
      const tracker = createSpeedTracker({ charsPerToken: options.tpsCharsPerToken })
      let signature = ""
      const publishSpeed = () => {
        const next = tracker.snapshot()
        const nextSignature = JSON.stringify(next)
        if (nextSignature === signature) return
        signature = nextSignature
        speeds.set(next)
      }
      const onSpeedEvent = (event) => {
        try {
          const details = event?.details ?? event
          const type = details?.type
          const data = details?.data ?? {}
          const dir = details?.location?.directory
          const here = context.location?.directory
          if (dir && here && dir !== here) return
          const sid = data.sessionID
          if (!sid) return
          switch (type) {
            case "session.execution.started":
            case "session.step.started":
              tracker.start(sid)
              break
            case "session.text.delta":
            case "session.reasoning.delta": {
              const delta = data.delta
              if (typeof delta === "string" && delta) tracker.push(sid, delta.length)
              break
            }
            case "session.execution.succeeded":
            case "session.execution.failed":
            case "session.execution.interrupted":
            case "session.idle":
              tracker.end(sid)
              break
            default:
              return
          }
          publishSpeed()
        } catch (error) {
          log.write(`speed event failed: ${error?.message ?? error}`)
        }
      }
      try {
        disposers.push(context.data.listen(onSpeedEvent))
      } catch (error) {
        log.write(`speed listen failed: ${error?.message ?? error}`)
      }
      const speedTimer = setInterval(publishSpeed, 500)
      disposers.push(() => {
        clearInterval(speedTimer)
        tracker.dispose()
      })
    }

    disposers.push(
      context.ui.slot({
        append: "prompt.footer.status",
        render: (slot) => (
          <PromptUsage
            context={context}
            state={state}
            speeds={options.tps ? speeds : undefined}
            sessionID={slot?.sessionID}
            colorMode={options.colorMode}
          />
        ),
      }),
    )

    const timer = setInterval(() => {
      void refresh()
    }, options.intervalSeconds * 1000)
    void refresh()

    return () => {
      disposed = true
      try {
        clearInterval(timer)
      } catch {
        // Timer may already be gone.
      }
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          // Disposal must never block plugin unload.
        }
      }
    }
  },
})
