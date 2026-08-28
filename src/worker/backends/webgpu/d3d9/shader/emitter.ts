/**
 * Small structured WGSL emitter shared by both shader stages.
 * The stack tracks open blocks so an incomplete function cannot be returned as valid WGSL.
 */
export class EmitterError extends Error {
    constructor(readonly code: "unbalanced-close" | "unclosed-block", message: string) {
        super(message);
        this.name = "EmitterError";
    }
}

export class Emitter {
    private readonly lines: string[] = [];
    private readonly blocks: string[] = [];
    private nextTemporary = 0;

    line(s: string): void {
        if (s.length === 0) {
            this.lines.push("");
            return;
        }
        this.lines.push(`${"    ".repeat(this.blocks.length)}${s}`);
    }

    open(header: string): void {
        if (header.trim().length === 0) throw new Error("Emitter.open requires a block header");
        this.line(`${header} {`);
        this.blocks.push(header);
    }

    close(footer?: string): void {
        if (this.blocks.length === 0) {
            throw new EmitterError("unbalanced-close", "Emitter.close called with no open block");
        }

        this.blocks.pop();
        this.line(footer === undefined ? "}" : `} ${footer} {`);
        if (footer !== undefined) this.blocks.push(footer);
    }

    tmp(prefix: string): string {
        const safePrefix = prefix.replace(/[^A-Za-z0-9_]/g, "_");
        return `_${safePrefix || "tmp"}${this.nextTemporary++}`;
    }

    depth(): number {
        return this.blocks.length;
    }

    toString(): string {
        if (this.blocks.length !== 0) {
            throw new EmitterError(
                "unclosed-block",
                `Emitter.toString called with ${this.blocks.length} unclosed block(s)`,
            );
        }
        return this.lines.join("\n");
    }
}
