use bottleship_lan_native::NativeError;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;
#[derive(Default)]
struct State {
    records: usize,
    bytes: usize,
    closed: bool,
}
pub struct Budget {
    state: Mutex<State>,
    records: usize,
    bytes: usize,
    changed: Notify,
}
pub struct Permit {
    budget: Arc<Budget>,
    bytes: usize,
}
impl Budget {
    pub fn new(records: usize, bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            records,
            bytes,
            changed: Notify::new(),
        })
    }
    pub fn reserve(self: &Arc<Self>, bytes: usize) -> Result<Permit, NativeError> {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if s.closed {
            return Err(NativeError::new(10050, "gateway closed"));
        }
        if s.records >= self.records || bytes > self.bytes.saturating_sub(s.bytes) {
            return Err(NativeError::new(
                10055,
                "gateway admission capacity exceeded",
            ));
        }
        s.records += 1;
        s.bytes += bytes;
        Ok(Permit {
            budget: self.clone(),
            bytes,
        })
    }
    pub async fn reserve_wait(self: &Arc<Self>, bytes: usize) -> Result<Permit, NativeError> {
        if bytes > self.bytes { return Err(NativeError::new(10055, "gateway output exceeds byte capacity")); }
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            match self.reserve(bytes) {
                Ok(permit) => return Ok(permit),
                Err(error) if error.code == 10055 => changed.await,
                Err(error) => return Err(error),
            }
        }
    }
    pub fn close(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
        self.changed.notify_waiters();
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut s = self.budget.state.lock().unwrap_or_else(|e| e.into_inner());
        s.records -= 1;
        s.bytes -= self.bytes;
        drop(s);
        self.budget.changed.notify_waiters();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn waiting_admission_wakes_on_release_and_close_without_leaking_capacity() {
        let budget = Budget::new(1, 8);
        let first = budget.reserve(8).unwrap();
        let waiting = budget.reserve_wait(4);
        tokio::pin!(waiting);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(20), &mut waiting).await.is_err());
        drop(first);
        let second = tokio::time::timeout(std::time::Duration::from_secs(1), &mut waiting).await.unwrap().unwrap();
        let closing = budget.reserve_wait(1);
        tokio::pin!(closing);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(20), &mut closing).await.is_err());
        budget.close();
        assert_eq!(tokio::time::timeout(std::time::Duration::from_secs(1), &mut closing).await.unwrap().err().unwrap().code, 10050);
        drop(second);
        assert_eq!(budget.reserve_wait(9).await.err().unwrap().code, 10055);
    }
    #[test]
    fn atomic_record_and_byte_admission() {
        let b = Budget::new(2, 3);
        let a = b.reserve(3).unwrap();
        assert!(b.reserve(1).is_err());
        let z = b.reserve(0).unwrap();
        assert!(b.reserve(0).is_err());
        drop(a);
        assert!(b.reserve(3).is_ok());
        drop(z);
        b.close();
        assert!(b.reserve(0).is_err());
    }
}
