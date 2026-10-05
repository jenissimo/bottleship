import React from "react";
import StorageManagerBody from "./StorageManagerBody";
import ms from "../ui/Modal/Modal.module.css";
import { useHostModal } from "../harness/use-host-modal";

/**
 * User-facing storage manager, reachable from the library page (not just Settings).
 * Thin modal chrome around the shared container-aware StorageManagerBody —
 * same view as Settings → "Library & Storage".
 */
interface Props {
    isOpen: boolean;
    onClose: () => void;
}

const StorageManagerModal: React.FC<Props> = ({ isOpen, onClose }) => {
    // Host modal, not a guest one — see harness/use-host-modal.ts.
    useHostModal("storageManager", isOpen, { caption: "Storage" });
    if (!isOpen) return null;

    return (
        <div className={ms["modal-overlay"]} onClick={onClose}>
            <div
                className={`${ms["modal-content"]} ${ms["opfs-tool-modal"]}`}
                onClick={(e) => e.stopPropagation()}
            >
                <div className={ms["modal-header"]}>
                    <h2>Storage</h2>
                    <button className={ms["modal-close"]} onClick={onClose}>×</button>
                </div>
                <div className={ms["modal-body"]}>
                    <StorageManagerBody active={isOpen} />
                </div>
            </div>
        </div>
    );
};

export default StorageManagerModal;
