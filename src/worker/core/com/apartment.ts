/**
 * Per-thread COM apartment state, shared by ole32 (CoInitialize*, OleInitialize) and
 * combase (RoInitialize) — on Windows both are views of the one TLS apartment.
 *
 * Semantics of combase enter_apartment/leave_apartment: the first initialization fixes
 * the thread's model, a matching re-initialization answers S_FALSE and is counted, a
 * different model is RPC_E_CHANGED_MODE and is NOT counted, and the apartment is left
 * when the count returns to zero.
 */

export const S_OK = 0x00000000;
export const S_FALSE = 0x00000001;
export const RPC_E_CHANGED_MODE = 0x80010106;

export const COINIT_MULTITHREADED = 0x0;
export const COINIT_APARTMENTTHREADED = 0x2;

export type ApartmentModel = "sta" | "mta";

interface ThreadApartment {
    model: ApartmentModel;
    inits: number;
    oleInits: number;
}

export class ComApartments {
    private threads = new Map<number, ThreadApartment>();

    static modelFromCoInit(dwCoInit: number): ApartmentModel {
        return (dwCoInit & COINIT_APARTMENTTHREADED) ? "sta" : "mta";
    }

    enter(threadId: number, model: ApartmentModel): number {
        const apt = this.threads.get(threadId);
        if (!apt) {
            this.threads.set(threadId, { model, inits: 1, oleInits: 0 });
            return S_OK;
        }
        if (apt.model !== model) return RPC_E_CHANGED_MODE;
        apt.inits++;
        return S_FALSE;
    }

    /** CoUninitialize: a call on an uninitialized thread is ignored. */
    leave(threadId: number): void {
        const apt = this.threads.get(threadId);
        if (!apt) return;
        if (--apt.inits <= 0) this.threads.delete(threadId);
    }

    /** OleInitialize: S_FALSE reports a repeated OLE initialization, not a repeated COM one. */
    enterOle(threadId: number): number {
        const hr = this.enter(threadId, "sta");
        if ((hr >>> 0) & 0x80000000) return hr;
        const apt = this.threads.get(threadId)!;
        return apt.oleInits++ === 0 ? S_OK : S_FALSE;
    }

    /** OleUninitialize without a matching OleInitialize leaves COM alone too. */
    leaveOle(threadId: number): void {
        const apt = this.threads.get(threadId);
        if (!apt || apt.oleInits === 0) return;
        apt.oleInits--;
        this.leave(threadId);
    }

    model(threadId: number): ApartmentModel | undefined {
        return this.threads.get(threadId)?.model;
    }

    isOleInitialized(threadId: number): boolean {
        return (this.threads.get(threadId)?.oleInits ?? 0) > 0;
    }

    /** Any thread in the MTA — which is what lets an uninitialized thread use it implicitly. */
    hasMta(): boolean {
        for (const apt of this.threads.values()) if (apt.model === "mta") return true;
        return false;
    }

    reset(): void {
        this.threads.clear();
    }
}

/** The process's apartments. One instance because ole32 and combase must agree. */
export const comApartments = new ComApartments();
