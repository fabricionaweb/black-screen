import * as _ from "lodash";
import * as i from "../Interfaces";
import * as React from "react";
import {Session} from "./Session";
import {ANSIParser} from "../ANSIParser";
import {Prompt} from "./Prompt";
import {ScreenBuffer} from "../ScreenBuffer";
import {CommandExecutor, NonZeroExitCodeError} from "./CommandExecutor";
import {PTY} from "../PTY";
import {PluginManager} from "../PluginManager";
import {EmitterWithUniqueID} from "../EmitterWithUniqueID";
import {Status} from "../Enums";
import {Environment} from "./Environment";
import {normalizeKey} from "../utils/Common";
import {TerminalLikeDevice} from "../Interfaces";
import {History} from "./History";

function makeThrottledDataEmitter(timesPerSecond: number, subject: EmitterWithUniqueID) {
    return _.throttle(() => subject.emit("data"), 1000 / timesPerSecond);
}

export class Job extends EmitterWithUniqueID implements TerminalLikeDevice {
    public command: PTY;
    public status: Status = Status.NotStarted;
    public readonly parser: ANSIParser;
    public interceptionResult: React.ReactElement<any> | undefined;
    private readonly _prompt: Prompt;
    private readonly _screenBuffer: ScreenBuffer;
    private readonly rareDataEmitter: Function;
    private readonly frequentDataEmitter: Function;
    private executedWithoutInterceptor: boolean = false;

    constructor(private _session: Session) {
        super();

        this._prompt = new Prompt(this);
        this._prompt.on("send", () => this.execute());

        this.rareDataEmitter = makeThrottledDataEmitter(1, this);
        this.frequentDataEmitter = makeThrottledDataEmitter(60, this);

        this._screenBuffer = new ScreenBuffer();
        this._screenBuffer.on("data", this.throttledDataEmitter);
        this.parser = new ANSIParser(this);
    }

    async executeWithoutInterceptor(): Promise<void> {
        if (!this.executedWithoutInterceptor) {
            this.executedWithoutInterceptor = true;
            try {
                await CommandExecutor.execute(this);

                // Need to check the status here because it's
                // executed even after the process was interrupted.
                if (this.status === Status.InProgress) {
                    this.setStatus(Status.Success);
                }
                this.emit("end");
            } catch (exception) {
                this.handleError(exception);
            }
        }
    }

    async execute({allowInterception = true} = {}): Promise<void> {
        History.add(this.prompt.value);

        if (this.status === Status.NotStarted) {
            this.setStatus(Status.InProgress);
        }

        const commandWords: string[] = this.prompt.expandedTokens.map(token => token.escapedValue);
        const interceptorOptions = {
            command: commandWords,
            presentWorkingDirectory: this.environment.pwd,
        };
        const interceptor = PluginManager.commandInterceptorPlugins.find(
            potentialInterceptor => potentialInterceptor.isApplicable(interceptorOptions)
        );

        await Promise.all(PluginManager.preexecPlugins.map(plugin => plugin(this)));
        if (interceptor && allowInterception) {
            if (!this.interceptionResult) {
                try {
                    this.interceptionResult = await interceptor.intercept(interceptorOptions);
                    this.setStatus(Status.Success);
                } catch (e) {
                    await this.executeWithoutInterceptor();
                }
            }
        } else {
            await this.executeWithoutInterceptor();
        }
        this.emit("end");
    }

    handleError(message: NonZeroExitCodeError | string): void {
        this.setStatus(Status.Failure);
        if (message) {
            if (message instanceof NonZeroExitCodeError) {
                // Do nothing.
            } else {
                this._screenBuffer.writeMany(message);
            }
        }
        this.emit("end");
    }

    // Writes to the process' STDIN.
    write(input: string|KeyboardEvent) {
        let text: string;

        if (typeof input === "string") {
            text = input;
        } else {
            text = input.ctrlKey ? String.fromCharCode(input.keyCode - 64) : normalizeKey(input.key, this.screenBuffer.cursorKeysMode);
        }

        this.command.write(text);
    }

    get session(): Session {
        return this._session;
    }

    get dimensions(): Dimensions {
        return this.session.dimensions;
    }

    set dimensions(dimensions: Dimensions) {
        this.session.dimensions = dimensions;
        this.winch();
    }

    hasOutput(): boolean {
        return !this._screenBuffer.isEmpty();
    }

    interrupt(): void {
        if (this.command && this.status === Status.InProgress) {
            this.command.kill("SIGINT");
            this.setStatus(Status.Interrupted);
            this.emit("end");
        }
    }

    winch(): void {
        if (this.command && this.status === Status.InProgress) {
            this.command.dimensions = this.dimensions;
        }
    }

    canBeDecorated(): boolean {
        return !!this.firstApplicableDecorator;
    }

    decorate(): React.ReactElement<any> {
        if (this.firstApplicableDecorator) {
            return this.firstApplicableDecorator.decorate(this);
        } else {
            throw "No applicable decorator found.";
        }
    }

    get environment(): Environment {
        // TODO: implement inline environment variable setting.
        return this.session.environment;
    }

    private get decorators(): i.OutputDecorator[] {
        return PluginManager.outputDecorators.filter(decorator =>
            this.status === Status.InProgress ? decorator.shouldDecorateRunningPrograms : true
        );
    }

    private get firstApplicableDecorator(): i.OutputDecorator | undefined {
        return this.decorators.find(decorator => decorator.isApplicable(this));
    }

    get screenBuffer(): ScreenBuffer {
        return this._screenBuffer;
    }

    get prompt(): Prompt {
        return this._prompt;
    }

    setStatus(status: Status): void {
        this.status = status;
        this.emit("status", status);
    }

    private throttledDataEmitter = () =>
        this._screenBuffer.size < ScreenBuffer.hugeOutputThreshold ? this.frequentDataEmitter() : this.rareDataEmitter();
}
