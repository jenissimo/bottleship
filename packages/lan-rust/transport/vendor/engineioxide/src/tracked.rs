//! BottleShip public ownership hook. No application payload is copied by this module.
use std::{fmt, sync::Arc};
use bytes::Bytes;
use engineioxide_core::PacketBuf;
/// Guard retained until a batch has left all Engine.IO-owned buffers.
pub type DeliveryGuard = Arc<dyn Send + Sync + 'static>;
#[derive(Clone)]
pub(crate) struct QueuedBatch { pub packets: PacketBuf, pub guard: Option<DeliveryGuard> }
impl fmt::Debug for QueuedBatch {
    fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result{f.debug_struct("QueuedBatch").field("packets",&self.packets).finish()}
}
impl From<PacketBuf> for QueuedBatch { fn from(packets:PacketBuf)->Self{Self{packets,guard:None}} }
/// Owns encoded polling bytes and their queue leases through HTTP Body / Hyper clones.
struct OwnedPayload { data:Bytes, _guards:Vec<DeliveryGuard> }
impl AsRef<[u8]> for OwnedPayload {fn as_ref(&self)->&[u8]{&self.data}}
pub(crate) fn own_payload(data:Bytes,guards:Vec<DeliveryGuard>)->Bytes {
    if guards.is_empty(){data}else{Bytes::from_owner(OwnedPayload{data,_guards:guards})}
}
