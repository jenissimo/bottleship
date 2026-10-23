//! Public physical-retirement observation, independent of queue capacity.
use std::sync::{Arc,atomic::{AtomicBool,AtomicUsize,Ordering}};
use tokio::sync::Notify;
#[derive(Debug,Default)] pub(crate) struct Retirement { active:AtomicUsize,drained:AtomicBool,changed:Notify }
#[derive(Debug)] pub struct TransportGuard(Arc<Retirement>);
impl Drop for TransportGuard {fn drop(&mut self){self.0.active.fetch_sub(1,Ordering::AcqRel);self.0.changed.notify_waiters();}}
impl Retirement {
 pub fn enter(self:&Arc<Self>)->TransportGuard{self.active.fetch_add(1,Ordering::AcqRel);TransportGuard(self.clone())}
 pub fn drain(&self){self.drained.store(true,Ordering::Release);self.changed.notify_waiters();}
 pub async fn wait(&self){loop{let changed=self.changed.notified();if self.drained.load(Ordering::Acquire)&&self.active.load(Ordering::Acquire)==0{return}changed.await;}}
}
