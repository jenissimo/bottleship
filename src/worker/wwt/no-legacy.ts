/** This build contains only the WWT CPU. Reaching legacy construction is a routing error. */
export class V86 {
    constructor() { throw new Error("Legacy CPU requested in a WWT-only build"); }
}
