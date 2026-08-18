import { SandboxManager } from "@anthropic-ai/sandbox-runtime"
import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig, resolveConfig } from "./config"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Shescape } from 'shescape'
import md5 from 'md5'

export type { SandboxPluginConfig } from "./config"

export function isProbableSandboxWrappedCommand(command: string): boolean {
  const trimmed = command.trim()
  const linuxWrapper =
    /^(?:[^\s'"]*\/)?bwrap\s/.test(trimmed) &&
    /\s--setenv\s+SANDBOX_RUNTIME\s+1(?:\s|$)/.test(trimmed)
  const macosWrapper =
    /^env\s+SANDBOX_RUNTIME=1\s/.test(trimmed) && /\s\/usr\/bin\/sandbox-exec\s/.test(trimmed)
  return linuxWrapper || macosWrapper
}

const shellKinds = new Set(["bash", "pwsh", "powershell", "cmd"])

export const SandboxPlugin: Plugin = async ({ client, directory, worktree }) => {
  const log = (level: "debug" | "info" | "warn" | "error", message: string, printToConsole: boolean = false) => {
    client.app.log({ body: { service: "opencode-sandbox", level, message } }).catch(() => undefined)
    if(printToConsole) {
      console[level]("[opencode-sandbox]", message)
    }
  }

  if (process.platform === "win32") {
    void log(
      "warn",
      "Windows sandboxing is not available through OpenCode's command-string hook; commands will run without sandbox",
      true
    )
    await new Promise(resolve => setTimeout(resolve, 5000))
    return {}
  }

  if (
    process.env.OPENCODE_DISABLE_SANDBOX === "1" ||
    process.env.OPENCODE_DISABLE_SANDBOX === "true"
  ) {
    void log(
      "info",
      "Sandbox is disabled by environment variable OPENCODE_DISABLE_SANDBOX",
      true
    )
    return {}
  }

  const userConfig = await loadConfig(directory)
  if (userConfig.disabled) {
    void log(
      "info",
      "Sandbox is disabled by configuration file",
      true
    )
    return {}
  }
  void log(
    "info",
    `Using sandbox with directory=${directory}, worktree=${worktree}.`,
    true
  )
  const isFailOpen = !!userConfig.failOpen
  if(isFailOpen) {
    void log(
      "warn",
      "WARN: Fail-open mode is enabled by configuration file. Commands will bypass sandbox if sandbox fails.",
      true
    )
  } else {
    void log(
      "info",
      "Fail-safe mode is used. Commands will fail if sandbox fails.",
      true
    )
  }

  const runtimeConfig = resolveConfig(directory, worktree, userConfig)

  let initialization: Promise<boolean> | undefined
  const ensureSandboxReady = () =>
    (initialization ??= SandboxManager.initialize(runtimeConfig)
      .then(() => {
        void log(
          "debug",
          `Initialized — writes allowed in: ${runtimeConfig.filesystem?.allowWrite?.join(", ")}`,
        )
        return true
      })
      .catch((err) => {
        void log(
          "error",
          `Failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
        )
        return false
      }))

  /**
   * Junk files that may be generated in write-allowed dirs due to sandbox runtime defect.
   * Needs to be cleaned up after execution.
   * 
   * Cleanup will only be triggered for files that are both empty and read-only.
   * 
   * See: https://github.com/anthropics/claude-code/issues/17087
   * Also: https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime/v/0.0.73 # Mandatory Deny Paths
   */
  const SRT_DEFECT_JUNK_FILES = [
    '.claude/agents',
    '.claude/commands',
    '.bash_profile',
    '.bashrc',
    '.gitconfig',
    '.gitmodules',
    '.idea',
    '.mcp.json',
    '.profile',
    '.ripgreprc',
    '.vscode',
    '.zprofile',
    '.zshrc',
  ]
  /**
   * For each directory, /*if a junk file starting with this prefix is removed/,
   * the directory will also be considered for removal,
   * and will be deleted as long as it is empty.
   * 
   * For nested directories,, children must be listed before parent.
   * 
   * Each entry must have a trailing slash.
   */
  const SRT_DEFECT_JUNK_DIRS = [
    '.claude/'
  ]
  /**
   * Handles SRT defect junk file removal for one writable path.
   */
  async function srt_defect_deleteJunkInDir(writablePath: string) {
    const removedFiles: string[] = []
    for(const junkFile of SRT_DEFECT_JUNK_FILES) {
      const filePath = path.join(writablePath, junkFile)
      try {
        if(!await fs.exists(filePath)) {
          continue
        }
        const stat = await fs.stat(filePath)
        if(!stat.isFile) {
          // Do not delete if not regular file
          continue
        }
        if(stat.size != 0) {
          // Do not delete non-empty ones
          continue
        }
        if((stat.mode & 0o222) != 0) {
          // Do not delete writable ones
          continue
        }
        try {
          await fs.rm(filePath)
          removedFiles.push(junkFile)
        } catch(err) {
          void log(
            'warn',
            `Failed to remove SRT defect junk file ${filePath}: ${err}`
          )
        }
      } catch(err) {
        void log(
          'warn',
          `Failed to check SRT defect junk file ${filePath}: ${err}`
        )
      }
    }
    for(const junkDir of SRT_DEFECT_JUNK_DIRS) {
      // const containsRemovedFile = removedFiles.filter(junkFile => junkFile.startsWith(junkDir)).length != 0
      // if(!containsRemovedFile) {
      //   continue
      // }
      const dirPath = path.join(writablePath, junkDir)
      try {
        if(!await fs.exists(dirPath)) {
          continue
        }
        const stat = await fs.stat(dirPath)
        if(!stat.isDirectory) {
          // Do not delete if not regular directory
          continue
        }
        const listing = await fs.readdir(dirPath)
        if(listing.length != 0) {
          // Do not delete if not empty
          continue
        }
        try {
          await fs.rmdir(dirPath)
        } catch(err) {
          void log(
            'warn',
            `Failed to remove SRT defect junk file ${dirPath}: ${err}`
          )
        }
      } catch(err) {
        void log(
          'warn',
          `Failed to check SRT defect junk directory ${dirPath}: ${err}`
        )
      }
    }
  }
  async function srt_defect_clearAllJunk() {
    for(const writablePath of runtimeConfig.filesystem.allowWrite) {
      await srt_defect_deleteJunkInDir(writablePath)
    }
  }
  // let junkClearTimeout: NodeJS.Timeout | null = null
  // function srt_defect_scheduleJunkClear(delay: number) {
  //   if(junkClearTimeout) {
  //     clearTimeout(junkClearTimeout)
  //   }
  //   junkClearTimeout = setTimeout(async () => {junkClearTimeout = null; await srt_defect_clearAllJunk()}, delay)
  // }
  // function srt_defect_rescheduleJunkClear(delay: number) {
  //   if(junkClearTimeout) {
  //     clearTimeout(junkClearTimeout)
  //     junkClearTimeout = setTimeout(async () => {junkClearTimeout = null; await srt_defect_clearAllJunk()}, delay)
  //   }
  // }
  // process.on('beforeExit', async () => {
  //   if(junkClearTimeout) {
  //     clearTimeout(junkClearTimeout)
  //   }
  //   await srt_defect_clearAllJunk()
  // })

  /**
   * Lazily initialize sandbox and then modified tool params to wrap command with sandbox.
   * 
   * Returns whether the command is modified or not.
   */
  async function modifyParams_(params?: {[_: string]: unknown}) {
    const command = params?.command
    if (params == undefined || command == undefined) {
      throw new Error('opencode-sandbox: Expected `command` to be passed into shell tool')
    }
    if (typeof command !== "string") {
      throw new Error('opencode-sandbox: Expected shell command to be string')
    }
    // Do not skip wrapper for already wrapped command - model may evade sandbox by pre-wrapping command with a lenient config.
    // if (isProbableSandboxWrappedCommand(command)) {
    //   return
    // }

    if (!(await ensureSandboxReady())) {
      if(isFailOpen) {
        void log(
          "warn",
          "Fail-open mode on, running without sandbox: " + command
        )
        return false
      } else {
        throw new Error(
          'opencode-sandbox: Sandbox failed to initialize. ' +
          'Do NOT attempt to initiate further bash calls unless the user instructs so, ' +
          'since another bash call will probably result in the same error without user intervention.'
        )
      }
    }
    try {
      const newCommand = await SandboxManager.wrapWithSandbox(
        command,
        undefined,
        undefined,
        undefined,
        { commandId: 'command', commandText: command },
      )
      params.command = newCommand
      return true
    } catch (err) {
      void log(
        "warn",
        `Failed to wrap command: ${err instanceof Error ? err.message : String(err)}`,
      )
      if(isFailOpen) {
        void log(
          "warn",
          "Fail-open mode on, running without sandbox: " + command
        )
        return false
      } else {
        throw new Error(
          'opencode-sandbox: Sandbox cannot wrap command. ' +
          'Do NOT attempt to initiate further bash calls unless the user instructs so, ' +
          'since another bash call will probably result in the same error without user intervention.'
        )
      }
    }
  }

  const originalCommands = new Map<string, string>()
  const hashPrefix = Math.random().toString()
  let hasToolDefinitionHookSucceeded = false
  
  return {
    /**
     * Tool definition hook: Only suitable for a modified version of OpenCode.
     * 
     * Cleanest. Wrap sandbox on-the-fly. Leaves no trace in the session history.
     */
    "tool.definition": async (input, output) => {
      if(!shellKinds.has(input.toolID)) {
        return
      }
      const executeFn = output.executeFn
      if(executeFn != undefined) {
        // Indicates that OpenCode is the private fork
        hasToolDefinitionHookSucceeded = true
      } else {
        // Tool definition executeFn hook unavailable.
        // Add a note to inform the LLM about the unability to preserve clean commands in chat history.
        output.description += (
          "\n" +
          'Note: Sandbox rewriting is on. ' +
          'Commands will be rewritten to enforce sandbox rules, and will appear in their rewritten forms in chat history.' +
          "\n"
        )
        return
      }
      output.executeFn = (params, ctx) => {
        const self = this

        return Effect.gen(function* () {
          // void log('info', JSON.stringify({ 'EXECWRAP': true, params, ctx }))
          const modifiedParams = yield* Effect.promise(async () => {
            // Be sure to modify params in non-mutating manner so the command does not end up wrapped in the chat history
            const modifiedParams = { ...params }
            await modifyParams_(modifiedParams)
            return modifiedParams
          })
          
          return yield* executeFn.call(self, modifiedParams, ctx)
        })
      }
    },

    /**
     * Before execution hook: Suitable for vanilla OpenCode.
     * 
     * The wrapped command will also appear in session history, and there seems to be no way to avoid this.
     * To avoid session bloat, the plugin creates a temporary shim file and executes that shim instead.
     */
    "tool.execute.before": async (input, output) => {
      if (hasToolDefinitionHookSucceeded) {
        return
      }
      if (!shellKinds.has(input.tool)) return

      const commandID = input.sessionID + '/' + input.callID
      const originalCommand = output.args?.command
      if(await modifyParams_(output.args)) {
        originalCommands.set(commandID, originalCommand)
        if(!userConfig.noShimFile) {
          const escaper = new Shescape({})
          const shimFilePath = path.join(os.tmpdir(), 'oc_sandboxed-' + md5(hashPrefix + ':' + commandID))
          const shimFileContent = (
            '#!/bin/sh' + "\n" +  // Make interpretable
            `rm ${escaper.escape(shimFilePath)} >/dev/null 2>&1` + "\n" +  // Remove self first
            output.args.command + "\n"  // Run wrapped command
          )
          await fs.writeFile(shimFilePath, shimFileContent, { mode: 0o500 })
          output.args.command = '/bin/sh ' + escaper.escape(shimFilePath) + ' ' + escaper.quote(originalCommand)
        }
      }
    },


    'event': async ({ event }) => {
      if(event.type != 'message.part.updated') {
        return
      }
      const part = event.properties.part
      if(part.type != 'tool') {
        return
      }
      if(part.state.status == 'pending' || part.state.status == 'running') {
        return
      }
      const commandID = part.sessionID + '/' + part.callID
      // Remove shim file if still exists (for example, in a rejected tool call)
      const shimFilePath = path.join(os.tmpdir(), 'oc_sandboxed-' + md5(hashPrefix + ':' + commandID))
      if(await fs.exists(shimFilePath)) {
        await fs.rm(shimFilePath)
      }
    },

    /**
     * Vain attempt to restore the original command in session history after modification by the before execution hook.
     * Does NOT work.
     * 
     * Note: This hook only activates for approved tool calls.
     */
    "tool.execute.after": async (input, output) => {
      if (!shellKinds.has(input.tool)) return

      const commandID = input.sessionID + '/' + input.callID
      // Restore original command so the UI shows it instead of the bwrap wrapper
      const originalCommand = originalCommands.get(commandID)
      let _updated = false
      if (originalCommand != undefined && input.args && typeof input.args.command === "string") {
        input.args.command = originalCommand
        output.title = originalCommand
        originalCommands.delete(commandID)
        _updated = true
      }

      await srt_defect_clearAllJunk()
    }
  }
}

// OpenCode 1.3.8+ discovers npm plugins through the target declared in
// package.json's `oc-plugin` field.
export const server = SandboxPlugin

export default SandboxPlugin
