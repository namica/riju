import { ChildProcess, spawn } from "child_process";
import * as path from "path";
import * as WebSocket from "ws";

import * as pty from "node-pty";
import { IPty } from "node-pty";
import * as rpc from "vscode-jsonrpc";
import { v4 as getUUID } from "uuid";

import { LangConfig, langs } from "./langs";
import { borrowUser } from "./users";
import * as util from "./util";
import { Context, Options, bash } from "./util";

const allSessions: Set<Session> = new Set();

export class Session {
  ws: WebSocket;
  uuid: string;
  lang: string;

  tearingDown: boolean = false;

  // Initialized by setup()
  uidInfo: {
    uid: number;
    returnUID: () => Promise<void>;
  } | null = null;

  // Initialized later or never
  term: { pty: IPty; live: boolean } | null = null;
  lsp: {
    proc: ChildProcess;
    reader: rpc.StreamMessageReader;
    writer: rpc.StreamMessageWriter;
  } | null = null;
  daemon: { proc: ChildProcess } | null = null;

  get homedir() {
    return `/tmp/riju/${this.uuid}`;
  }

  get config() {
    return langs[this.lang];
  }

  get uid() {
    return this.uidInfo!.uid;
  }

  returnUID = async () => {
    this.uidInfo && (await this.uidInfo.returnUID());
  };

  get context() {
    return { uid: this.uid, uuid: this.uuid };
  }

  get env() {
    return util.getEnv(this.uuid);
  }

  log = (msg: string) => console.log(`[${this.uuid}] ${msg}`);

  constructor(ws: WebSocket, lang: string) {
    this.ws = ws;
    this.uuid = getUUID();
    this.lang = lang;
    this.log(`Creating session, language ${this.lang}`);
    this.setup();
  }

  run = async (args: string[], options?: Options) => {
    return await util.run(args, this.log, options);
  };

  privilegedSetup = () => util.privilegedSetup(this.context);
  privilegedSpawn = (args: string[]) =>
    util.privilegedSpawn(this.context, args);
  privilegedUseradd = () => util.privilegedUseradd(this.uid);
  privilegedTeardown = () => util.privilegedTeardown(this.context);

  setup = async () => {
    try {
      allSessions.add(this);
      const { uid, returnUID } = await borrowUser(this.log);
      this.uidInfo = { uid, returnUID };
      this.log(`Borrowed uid ${this.uid}`);
      await this.run(this.privilegedSetup());
      await this.runCode();
      if (this.config.daemon) {
        const daemonArgs = this.privilegedSpawn(bash(this.config.daemon));
        const daemonProc = spawn(daemonArgs[0], daemonArgs.slice(1), {
          env: this.env,
        });
        this.daemon = {
          proc: daemonProc,
        };
        for (const stream of [daemonProc.stdout, daemonProc.stderr]) {
          stream.on("data", (data) =>
            this.send({
              event: "serviceLog",
              service: "daemon",
              output: data.toString("utf8"),
            })
          );
          daemonProc.on("exit", (code, signal) =>
            this.send({
              event: "serviceFailed",
              service: "daemon",
              error: `Exited with status ${signal || code}`,
            })
          );
          daemonProc.on("error", (err) =>
            this.send({
              event: "serviceFailed",
              service: "daemon",
              error: `${err}`,
            })
          );
        }
      }
      if (this.config.lsp) {
        if (this.config.lspSetup) {
          await this.run(this.privilegedSpawn(bash(this.config.lspSetup)));
        }
        const lspArgs = this.privilegedSpawn(bash(this.config.lsp));
        const lspProc = spawn(lspArgs[0], lspArgs.slice(1), { env: this.env });
        this.lsp = {
          proc: lspProc,
          reader: new rpc.StreamMessageReader(lspProc.stdout),
          writer: new rpc.StreamMessageWriter(lspProc.stdin),
        };
        this.lsp.reader.listen((data: any) => {
          this.send({ event: "lspOutput", output: data });
        });
        lspProc.stderr.on("data", (data) =>
          this.send({
            event: "serviceLog",
            service: "lsp",
            output: data.toString("utf8"),
          })
        );
        lspProc.on("exit", (code, signal) =>
          this.send({
            event: "serviceFailed",
            service: "lsp",
            error: `Exited with status ${signal || code}`,
          })
        );
        lspProc.on("error", (err) =>
          this.send({ event: "serviceFailed", service: "lsp", error: `${err}` })
        );
        this.send({ event: "lspStarted", root: this.homedir });
      }
      this.ws.on("message", this.receive);
      this.ws.on("close", async () => {
        await this.teardown();
      });
      this.ws.on("error", async (err) => {
        this.log(`Websocket error: ${err}`);
        await this.teardown();
      });
    } catch (err) {
      this.log(`Error while setting up environment`);
      console.log(err);
      this.sendError(err);
      await this.teardown();
    }
  };

  send = async (msg: any) => {
    try {
      if (this.tearingDown) {
        return;
      }
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      this.log(`Failed to send websocket message: ${err}`);
      await this.teardown();
    }
  };

  sendError = async (err: any) => {
    await this.send({ event: "terminalClear" });
    await this.send({
      event: "terminalOutput",
      output: `Riju encountered an unexpected error: ${err}
\r
\rYou may want to save your code and refresh the page.
`,
    });
  };

  logBadMessage = (msg: any) => {
    this.log(`Got malformed message from client: ${msg}`);
  };

  receive = async (event: string) => {
    try {
      if (this.tearingDown) {
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(event);
      } catch (err) {
        this.log(`Failed to parse message from client: ${msg}`);
        return;
      }
      switch (msg && msg.event) {
        case "terminalInput":
          if (typeof msg.input !== "string") {
            this.logBadMessage(msg);
            break;
          }
          if (!this.term) {
            this.log("terminalInput ignored because term is null");
            break;
          }
          this.term!.pty.write(msg.input);
          break;
        case "runCode":
          if (typeof msg.code !== "string") {
            this.logBadMessage(msg);
            break;
          }
          await this.runCode(msg.code);
          break;
        case "lspInput":
          if (typeof msg.input !== "object" || !msg) {
            this.logBadMessage(msg);
            break;
          }
          if (!this.lsp) {
            this.log(`lspInput ignored because lsp is null`);
            break;
          }
          this.lsp.writer.write(msg.input);
          break;
        default:
          this.logBadMessage(msg);
          break;
      }
    } catch (err) {
      this.log(`Error while handling message from client`);
      console.log(err);
      this.sendError(err);
    }
  };

  runCode = async (code?: string) => {
    try {
      const {
        name,
        repl,
        main,
        suffix,
        createEmpty,
        compile,
        run,
        template,
        hacks,
      } = this.config;
      if (this.term) {
        const pid = this.term.pty.pid;
        const args = this.privilegedSpawn(
          bash(`kill -SIGTERM ${pid}; sleep 3; kill -SIGKILL ${pid}`)
        );
        spawn(args[0], args.slice(1), { env: this.env });
        // Signal to terminalOutput message generator using closure.
        this.term.live = false;
        this.term = null;
      }
      this.send({ event: "terminalClear" });
      let cmdline: string;
      if (code) {
        cmdline = run;
        if (compile) {
          cmdline = `( ${compile} ) && ( ${run} )`;
        }
      } else if (repl) {
        cmdline = repl;
      } else {
        cmdline = `echo '${name} has no REPL, press Run to see it in action'`;
      }
      if (code === undefined) {
        code = createEmpty ? "" : template;
      }
      if (code && suffix) {
        code += suffix;
      }
      if (main.includes("/")) {
        await this.run(
          this.privilegedSpawn([
            "mkdir",
            "-p",
            path.dirname(`${this.homedir}/${main}`),
          ])
        );
      }
      await this.run(
        this.privilegedSpawn([
          "sh",
          "-c",
          `cat > ${path.resolve(this.homedir, main)}`,
        ]),
        { input: code }
      );
      if (hacks && hacks.includes("ghci-config") && run) {
        if (code) {
          await this.run(
            this.privilegedSpawn(["sh", "-c", `cat > ${this.homedir}/.ghci`]),
            { input: ":load Main\nmain\n" }
          );
        } else {
          await this.run(
            this.privilegedSpawn(["rm", "-f", `${this.homedir}/.ghci`])
          );
        }
      }
      const termArgs = this.privilegedSpawn(bash(cmdline));
      const term = {
        pty: pty.spawn(termArgs[0], termArgs.slice(1), {
          name: "xterm-color",
          env: this.env,
        }),
        live: true,
      };
      this.term = term;
      this.term.pty.on("data", (data) => {
        // Capture term in closure so that we don't keep sending output
        // from the old pty even after it's been killed (see ghci).
        if (term.live) {
          this.send({ event: "terminalOutput", output: data });
        }
      });
    } catch (err) {
      this.log(`Error while running user code`);
      console.log(err);
      this.sendError(err);
    }
  };

  teardown = async () => {
    try {
      if (this.tearingDown) {
        return;
      }
      this.log(`Tearing down session`);
      this.tearingDown = true;
      allSessions.delete(this);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await this.run(this.privilegedTeardown());
      await this.returnUID();
      this.ws.terminate();
    } catch (err) {
      this.log(`Error during teardown`);
      console.log(err);
    }
  };
}
