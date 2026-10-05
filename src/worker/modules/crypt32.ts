import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";

export class Crypt32 implements IModule {
    name = "crypt32";
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // BOOL CertFreeCertificateContext(PCCERT_CONTEXT pCertContext)
        this.exports["CertFreeCertificateContext"] = (ctx, mem, args) => {
            return { value: 1, stackCleanup: 4 }; // TRUE
        };

        // PCCERT_CONTEXT CertFindCertificateInStore(HCERTSTORE hCertStore, DWORD dwCertEncodingType,
        //   DWORD dwFindFlags, DWORD dwFindType, const void *pvFindPara, PCCERT_CONTEXT pPrevCertContext)
        this.exports["CertFindCertificateInStore"] = (ctx, mem, args) => {
            return { value: 0, stackCleanup: 24 }; // NULL — not found
        };

        // BOOL CryptMsgGetParam(HCRYPTMSG hCryptMsg, DWORD dwParamType, DWORD dwIndex,
        //   void *pvData, DWORD *pcbData)
        this.exports["CryptMsgGetParam"] = (ctx, mem, args) => {
            return { value: 0, stackCleanup: 20 }; // FALSE
        };

        // BOOL CryptQueryObject(DWORD dwObjectType, const void *pvObject, DWORD dwExpectedContentTypeFlags,
        //   DWORD dwExpectedFormatTypeFlags, DWORD dwFlags, DWORD *pdwMsgAndCertEncodingType,
        //   DWORD *pdwContentType, DWORD *pdwFormatType, HCERTSTORE *phCertStore,
        //   HCRYPTMSG *phMsg, const void **ppvContext)
        this.exports["CryptQueryObject"] = (ctx, mem, args) => {
            return { value: 0, stackCleanup: 44 }; // FALSE
        };

        // BOOL CertCloseStore(HCERTSTORE hCertStore, DWORD dwFlags)
        this.exports["CertCloseStore"] = (ctx, mem, args) => {
            return { value: 1, stackCleanup: 8 }; // TRUE
        };

        // BOOL CryptMsgClose(HCRYPTMSG hCryptMsg)
        this.exports["CryptMsgClose"] = (ctx, mem, args) => {
            return { value: 1, stackCleanup: 4 }; // TRUE
        };

        // DWORD CertGetNameStringA(PCCERT_CONTEXT pCertContext, DWORD dwType, DWORD dwFlags,
        //   void *pvTypePara, LPSTR pszNameString, DWORD cchNameString)
        const certGetNameString = (wide: boolean) => (ctx: any, mem: Uint8Array, args: number[]) => {
            const pszNameString = args[4] >>> 0;
            const cchNameString = args[5] >>> 0;
            // Empty string. A wide terminator is TWO bytes — one leaves the caller reading
            // whatever followed as the second half of a character.
            if (pszNameString && cchNameString > 0) {
                Mem.writeUint8(pszNameString, 0);
                if (wide) Mem.writeUint8(pszNameString + 1, 0);
            }
            return { value: 1, stackCleanup: 24 }; // 1 char written (null terminator)
        };

        this.exports["CertGetNameStringA"] = certGetNameString(false);
        this.exports["CertGetNameStringW"] = certGetNameString(true);
        this.exports["CertGetNameString"] = certGetNameString(false);
    }
}
