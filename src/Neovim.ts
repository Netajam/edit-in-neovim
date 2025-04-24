import { TFile, FileSystemAdapter, Notice } from "obsidian";
import { findNvim, attach } from "neovim";
import { EditInNeovimSettings } from "./Settings";
import * as child_process from "node:child_process";
import * as os from "node:os";
import { isPortInUse, searchForBinary, searchDirs } from "./utils";

export default class Neovim {
  instance: ReturnType<typeof attach> | undefined;
  process: ReturnType<(typeof child_process)["spawn"]> | undefined;
  settings: EditInNeovimSettings;
  nvimBinary: ReturnType<typeof findNvim>["matches"][number];
  termBinary: string | undefined;
  adapter: FileSystemAdapter;
  apiKey: string | undefined;

  constructor(settings: EditInNeovimSettings, adapter: FileSystemAdapter, apiKey: string | undefined) {
    this.adapter = adapter;
    this.settings = settings;
    this.apiKey = apiKey;
    this.termBinary = searchForBinary(settings.terminal);

    // Determine Neovim binary path
    if (settings.pathToBinary) {
      console.log(`Using manual Neovim path: ${settings.pathToBinary}`);
      this.nvimBinary = { path: settings.pathToBinary, nvimVersion: "manual_path" };
    } else {
      console.log("Searching for Neovim binary in default locations...");
      const found = findNvim({ orderBy: "desc", paths: searchDirs });
      if (found.matches.length > 0) {
        this.nvimBinary = found.matches[0];
      } else {
        // Handle case where findNvim finds nothing gracefully
        this.nvimBinary = { path: "", error: new Error("Neovim binary not found automatically.") };
        new Notice("Edit In Neovim: Could not automatically find a Neovim binary. Please set the path manually in settings or ensure nvim is in your PATH.", 10000);
      }
    }

    // Log potential issues with the determined Neovim path
    if (this.nvimBinary.path && !this.nvimBinary.nvimVersion && settings.pathToBinary) {
      console.warn(`Using manually provided Neovim path: ${this.nvimBinary.path}. Version check skipped.`);
    } else if (!this.nvimBinary.path && this.nvimBinary.error) {
      console.error(`Failed to find or configure Neovim binary: ${this.nvimBinary.error.message}`);
    } else if (!this.nvimBinary.path && !settings.pathToBinary) {
      console.error("Neovim binary path could not be determined.");
      new Notice("Edit In Neovim: Could not determine Neovim binary path.", 10000);
    }
    else {
      console.log(`Neovim Information:
  - Term Path: ${this.termBinary || "Not Found/Not Set"}
  - Nvim Path: ${this.nvimBinary.path}
  - Version: ${this.nvimBinary.nvimVersion || "N/A (Manual Path or Check Failed)"}
  - Error State: ${this.nvimBinary.error ? this.nvimBinary.error.message : "None"}`);
    }

    // Check terminal binary existence
    if (!this.termBinary) {
      console.warn(`Could not find terminal binary for: '${settings.terminal}'. Is it installed and in your PATH? Spawning Neovim might fail.`);
    }
  }

  getBuffers = async () => {
    if (!this.instance) return Promise.resolve([]);
    try {
      return await this.instance.buffers;
    } catch (error) {
      console.error("Failed to get Neovim buffers:", error);
      new Notice(`Error communicating with Neovim: ${error.message}`, 5000);
      return [];
    }
  };

  async newInstance(adapter: FileSystemAdapter) {
    if (this.process) {
      new Notice("Linked Neovim instance already running", 5000);
      console.log("newInstance called, but process already exists.");
      return;
    }

    if (!this.termBinary) {
      new Notice(`Unknown terminal: '${this.settings.terminal}'. Is it installed and on your PATH? Cannot start Neovim.`, 8000);
      console.error("newInstance failed: Terminal binary path is missing.");
      return;
    }
    if (!this.nvimBinary || !this.nvimBinary.path) {
      new Notice("Neovim binary path is not configured correctly. Cannot start Neovim.", 8000);
      console.error("newInstance failed: Neovim binary path is missing.");
      return;
    }

    const termPath = this.termBinary;
    const nvimPath = this.nvimBinary.path;
    const listenArg = this.settings.listenOn;
    const extraEnvVars: Record<string, string> = {};
    if (this.apiKey) extraEnvVars["OBSIDIAN_REST_API_KEY"] = this.apiKey;

    let spawnArgs: string[] = [];
    const spawnOptions: child_process.SpawnOptionsWithoutStdio = {
      cwd: adapter.getBasePath(),
      env: { ...process.env, ...extraEnvVars },
      shell: false,
      detached: false,
    };

    if (process.platform === 'win32') {
      const terminalName = termPath.split('\\').pop()?.toLowerCase() || '';

      if (terminalName === 'alacritty.exe' || terminalName === 'wezterm.exe' || terminalName === 'kitty.exe') {
        spawnArgs = ['-e', nvimPath, '--listen', listenArg];
      }
      else if (terminalName === 'wt.exe') {
        spawnArgs = ['new-tab', '--title', 'Neovim', nvimPath, '--listen', listenArg];
      }
      else if (terminalName === 'powershell.exe' || terminalName === 'pwsh.exe') {
        const command = `Start-Process -FilePath '${nvimPath}' -ArgumentList '--listen ${listenArg}' -WindowStyle Normal`;
        spawnArgs = ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-NoExit', '-Command', command];
        spawnOptions.shell = true;
      }
      else if (terminalName === 'cmd.exe') {
        spawnArgs = ['/c', 'start', `"Neovim"`, `"${nvimPath}"`, '--listen', listenArg];
        spawnOptions.shell = true;
      }
      else {
        console.warn(`Unknown/unhandled Windows terminal: ${termPath}. Attempting generic '-e' execution (shell: false). This may fail.`);
        spawnArgs = ['-e', nvimPath, '--listen', listenArg];
      }

    } else {
      // Linux/macOS logic
      spawnArgs = ["-e", nvimPath, "--listen", listenArg];
      spawnOptions.shell = os.userInfo().shell || true;
      console.log(`Using config for non-Windows: shell: ${spawnOptions.shell}, args: ${JSON.stringify(spawnArgs)}`);
    }

    console.log(`Attempting to spawn process:
      Platform: ${process.platform}
      Executable: ${termPath}
      Arguments: ${JSON.stringify(spawnArgs)}
      Options: ${JSON.stringify(spawnOptions)}`);

    try {
      this.process = child_process.spawn(termPath, spawnArgs, spawnOptions);

      if (!this.process || this.process.pid === undefined) {
        console.error("Failed to spawn process object or PID is undefined immediately after spawn call.");
        new Notice("Failed to create Neovim process object.", 7000);
        this.process = undefined; // Ensure cleanup
        return;
      }

      console.log(`Process spawned successfully with PID: ${this.process.pid}`);

      // --- Attach Event Handlers ---

      this.process.on("error", (err) => {
        console.error("Neovim child_process emitted 'error' event:", err);
        let message = `Failed to start Neovim process: ${err.message}`;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          message = `Could not find executable: ${termPath}. Is it installed and in PATH?`;
        } else if ((err as NodeJS.ErrnoException).code === 'EACCES') {
          message = `Permission denied executing: ${termPath}`;
        }
        new Notice(message, 10000);
        this.process = undefined;
        this.instance = undefined;
      });

      this.process.on("close", (code, signal) => {
        if (this.process) {
          this.process = undefined;
          this.instance = undefined;
        }
      });

      this.process.on("exit", (code, signal) => {
        if (this.process) {
          this.process = undefined;
          this.instance = undefined;
          console.log("Neovim instance and process state cleared on 'exit'.");
        }
      });

      this.process.on("disconnect", () => {
        console.log("Neovim process 'disconnect' event.");
        if (this.process) {
          this.process = undefined;
          this.instance = undefined;
          console.log("Neovim instance and process state cleared on 'disconnect'.");
        }
      });

      // --- Attach to Neovim RPC ---
      console.log("Attempting to attach to Neovim RPC via process...");
      this.instance = attach({ proc: this.process });
      console.log("Neovim attach call completed.");

      setTimeout(async () => {
        if (!this.instance) return;
        try {
          await this.instance.eval('1');
          console.log("Neovim RPC connection test successful.");
          new Notice("Neovim instance started and connected.", 3000);
        } catch (rpcError) {
          console.error("Neovim RPC connection failed after spawn:", rpcError);
          new Notice(`Failed to establish RPC connection: ${rpcError.message}`, 7000);
          this.close();
        }
      }, 1500);

    } catch (spawnError) {
      console.error("Error caught during child_process.spawn call itself:", spawnError);
      new Notice(`Error trying to spawn Neovim: ${spawnError.message}`, 10000);
      this.process = undefined;
      this.instance = undefined;
    }
  }

  openFile = async (file: TFile | null) => {
    if (!file) {
      console.log("openFile called with null file.");
      return;
    }

    // --- File Type Filtering ---
    const isExcalidrawMd = file.extension === "md" && file.path.endsWith(".excalidraw.md");
    let isSupported = this.settings.supportedFileTypes.includes(file.extension);

    // Handle Excalidraw explicitly based on settings
    if (isExcalidrawMd) {
      if (this.settings.supportedFileTypes.includes("excalidraw")) {
        isSupported = true;
        console.log(`Opening Excalidraw file: ${file.path}`);
      } else {
        isSupported = false;
        console.log(`Skipping Excalidraw file (type not enabled): ${file.path}`);
      }
    } else if (!isSupported) {
      console.log(`Skipping unsupported file type '${file.extension}': ${file.path}`);
    }

    if (!isSupported) return;

    // --- Check Neovim Connection Status ---
    const nvimPath = this.nvimBinary?.path;
    const listenAddress = this.settings.listenOn;
    const port = listenAddress.split(':').at(-1);

    if (!nvimPath) {
      console.error("Cannot open file: Neovim binary path is not configured.");
      new Notice("Neovim path unknown, cannot open file.", 7000);
      return;
    }

    let canConnect = false;
    if (this.instance && this.process) {
      console.log("Found active Neovim instance managed by plugin.");
      canConnect = true;
    } else if (port) {
      console.log(`Checking if external Neovim is listening on port ${port}...`);
      try {
        if (await isPortInUse(port)) {
          console.log(`Port ${port} is in use. Assuming external Neovim instance is running.`);
          new Notice(`Opening file in external Neovim on ${listenAddress}...`, 3000);
          canConnect = true;
        } else {
          console.log(`Port ${port} is not in use. No Neovim instance found.`);
        }
      } catch (error) {
        console.error(`Error checking port ${port}:`, error);
      }
    }

    if (!canConnect) {
      console.log("No running Neovim instance (internal or external) found to open file in.");
      new Notice("No running Neovim found. Use 'Open Neovim' or ensure an external instance is listening.", 5000);
      return;
    }

    // --- Execute --remote Command ---
    const absolutePath = this.adapter.getFullPath(file.path);
    console.log(`Requesting Neovim on ${listenAddress} to open: ${absolutePath}`);

    const args = ['--server', listenAddress, '--remote', absolutePath];

    try {
      child_process.execFile(nvimPath, args, (error, stdout, stderr) => {
        if (error) {
          // Log detailed error info
          console.error(`execFile '--remote' error:
                  Command: ${nvimPath}
                  Args: ${JSON.stringify(args)}
                  Error Code: ${error.code}
                  Error Signal: ${error.signal}
                  Error Message: ${error.message}
                  Stderr: ${stderr}`);

          // Provide user feedback based on error type
          let noticeMessage = `Error opening file in Neovim: ${error.message}`;
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            noticeMessage = `Neovim executable not found at: ${nvimPath}`;
          } else if (stderr && (stderr.includes('ECONNREFUSED') || stderr.includes('Connection refused'))) {
            noticeMessage = `Could not connect to Neovim server at ${listenAddress}. Is it running?`;
          } else if (stderr && stderr.includes("No such file or directory") && stderr.includes(absolutePath)) {
            noticeMessage = `Neovim server reported error finding file: ${file.basename}`;
          } else if (stderr) {
            noticeMessage = `Error opening file in Neovim: ${stderr.split('\n')[0]}`;
          }
          new Notice(noticeMessage, 10000);
          return;
        }
        if (stdout) console.log(`Neovim --remote stdout: ${stdout}`);
        if (stderr) console.warn(`Neovim --remote stderr: ${stderr}`);
        console.log(`Successfully sent '--remote' command for: ${file.path}`);
      });
    } catch (execFileError) {
      console.error("Error caught during child_process.execFile call:", execFileError);
      new Notice(`Failed to run Neovim command: ${execFileError.message}`, 10000);
    }
  };

  close = () => {
    console.log("Close method called.");
    if (this.instance) {
      console.log("Attempting to quit Neovim instance via RPC...");
      try {
        this.instance.quit()
      } catch (e) {
        console.error("Error during instance.quit():", e);
      }
      this.instance = undefined;
    } else {
      console.log("No active Neovim instance object to quit via RPC.");
    }

    if (this.process) {
      console.log(`Killing Neovim process (PID: ${this.process.pid})...`);
      const killed = this.process.kill('SIGTERM');
      console.log(`Process kill('SIGTERM') returned: ${killed}`);
      this.process = undefined;
    } else {
      console.log("No active Neovim process object to kill.");
    }

    console.log("Neovim instance and process references cleared.");
    new Notice("Neovim instance closed.", 3000);
  };
}
