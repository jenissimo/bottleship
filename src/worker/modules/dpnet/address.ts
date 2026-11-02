import { DPN, DP8_TCPIP, DP8_IPX, utf16, fromUtf16, guidBytes, guidString, bytesEqual } from "./constants";
import { decodeAnsiString, getAnsiCodePage } from "../codepage-utils";

export interface AddressComponent { name: string; type: number; data: Uint8Array; }
const required: Record<string, number> = { provider: 3, device: 3, hostname: 1, port: 2,
    applicationinstance: 3, baud: 2, flowcontrol: 1, parity: 1, phonenumber: 1, program: 3, stopbits: 1 };
const shortcuts: Record<string, string> = { IP: DP8_TCPIP, IPX: DP8_IPX,
    MODEM: "6d4a3650-628d-11d2-ae0f-006097b01411", SERIAL: "743b5d60-628d-11d2-ae0f-006097b01411" };
const simple = /^[a-zA-Z0-9?.,+_-]$/;
function escape(value: string): string {
    let out = "";
    for (let i = 0; i < value.length; i++) { const c = value[i]; out += simple.test(c) ? c : c === "%" ? "%%" : "%" + value.charCodeAt(i).toString(16).toUpperCase().padStart(2, "0").slice(0, 2); }
    return out;
}
function unescape(value: string): string | null {
    let out = "";
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (simple.test(c)) out += c;
        else if (c === "%" && value[i + 1] === "%") { out += "%"; ++i; }
        else if (c === "%" && /^[0-9a-f]{2}$/i.test(value.slice(i + 1, i + 3))) { out += String.fromCharCode(parseInt(value.slice(i + 1, i + 3), 16)); i += 2; }
        else return null;
    }
    return out;
}
/** Ordered address components, separate from process-owned COM storage. */
export class DirectPlayAddress {
    components: AddressComponent[] = [];
    userData: Uint8Array = new Uint8Array();
    clear(): void { this.components = []; this.userData = new Uint8Array(); }
    clone(): DirectPlayAddress { const a = new DirectPlayAddress(); a.assign(this); return a; }
    assign(other: DirectPlayAddress): void {
        this.components = other.components.map(c => ({ ...c, data: c.data.slice() }));
        this.userData = other.userData.slice();
    }
    get(name: string): AddressComponent | undefined { return this.components.find(c => c.name.toLowerCase() === name.toLowerCase()); }
    set(name: string, bytes: Uint8Array, type: number): number {
        if (type < 1 || type > 5) return DPN.INVALIDPARAM;
        let data: Uint8Array = bytes.slice();
        if ((type === 2 && data.length !== 4) || (type === 3 && data.length !== 16)) return DPN.INVALIDPARAM;
        if (type === 1) {
            if (data.length < 2 || data.length % 2 || (fromUtf16(data).length + 1) * 2 !== data.length) return DPN.INVALIDPARAM;
        } else if (type === 5) {
            if (!data.length || data.indexOf(0) !== data.length - 1) return DPN.INVALIDPARAM;
            data = utf16(decodeAnsiString(data, 0, data.length - 1, getAnsiCodePage()) + "\0"); type = 1;
        }
        const key = name.toLowerCase();
        if (key === "provider" && type === 1) {
            const guid = shortcuts[fromUtf16(data).toUpperCase()];
            if (!guid) return DPN.INVALIDPARAM;
            data = guidBytes(guid); type = 3;
        }
        if (required[key] && required[key] !== type) return DPN.INVALIDPARAM;
        const index = this.components.findIndex(c => c.name.toLowerCase() === key);
        const component = { name: index < 0 ? name : this.components[index].name, type, data };
        if (index >= 0) this.components[index] = component;
        else if (key === "provider") this.components.unshift(component);
        else if (key === "device") this.components.splice(this.get("provider") ? 1 : 0, 0, component);
        else this.components.push(component);
        return DPN.OK;
    }
    setDword(name: string, value: number): number { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value, true); return this.set(name, b, 2); }
    setGuid(name: string, guid: string): number { return this.set(name, guidBytes(guid), 3); }
    setText(name: string, text: string): number { return this.set(name, utf16(text + "\0"), 1); }
    dword(name: string): number | undefined { const c = this.get(name); return c?.type === 2 ? new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength).getUint32(0, true) : undefined; }
    text(name: string): string | undefined { const c = this.get(name); return c?.type === 1 ? fromUtf16(c.data) : undefined; }
    guid(name: string): string | undefined { const c = this.get(name); return c?.type === 3 ? guidString(c.data) : undefined; }
    equal(other: DirectPlayAddress): boolean {
        return this.url().toLowerCase() === other.url().toLowerCase();
    }
    url(): string {
        return "x-directplay:/" + this.components.map(c => {
            let value: string;
            if (c.type === 1) value = escape(fromUtf16(c.data));
            else if (c.type === 2) value = String(new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength).getInt32(0, true));
            else if (c.type === 3) value = "%7B" + guidString(c.data).toUpperCase() + "%7D";
            else value = escape(String.fromCharCode(...c.data));
            return c.name + "=" + value;
        }).join(";") + (this.userData.length ? "#" + escape(String.fromCharCode(...this.userData)) : "");
    }
    buildURL(url: string): number {
        // Native clears the previous address before parsing, and retains committed components on failure.
        this.clear();
        if (!url.startsWith("x-directplay:/")) return DPN.INVALIDURL;
        const body = url.slice("x-directplay:/".length), separator = body.indexOf("#"), parts = (separator < 0 ? body : body.slice(0, separator));
        if (parts) for (const item of parts.split(";")) {
            const at = item.indexOf("=");
            if (at < 0 || !/^[a-zA-Z0-9?.,+_-]*$/.test(item.slice(0, at))) return DPN.INVALIDURL;
            const name = item.slice(0, at), raw = item.slice(at + 1), value = unescape(raw);
            if (value === null || !value.length) return DPN.INVALIDURL;
            const expected = required[name.toLowerCase()];
            let hr: number;
            if ((!expected || expected === 2) && /^\d{1,10}$/.test(raw)) hr = this.setDword(name, Number(value) >>> 0);
            else if ((!expected || expected === 3) && /^\{[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/i.test(value)) hr = this.setGuid(name, value);
            else if (!value.includes("\0")) hr = this.setText(name, value);
            else hr = this.set(name, utf16(value), 4);
            if (hr) return DPN.INVALIDURL;
        }
        if (separator >= 0) {
            const value = unescape(body.slice(separator + 1)); if (value === null) return DPN.INVALIDURL;
            this.userData = Uint8Array.from(value, c => c.charCodeAt(0) & 255);
        }
        return DPN.OK;
    }
    buildHost(host: string, port: number): number {
        this.clear(); this.setGuid("provider", DP8_TCPIP); this.setText("hostname", host); this.setDword("port", port & 0xffff); return DPN.OK;
    }
    buildLocal(device: string, port: number): number {
        this.clear(); this.setGuid("provider", DP8_TCPIP); this.setGuid("device", device); this.setDword("port", port & 0xffff); return DPN.OK;
    }
}
