use bottleship_lan_native::NativeError;
use std::sync::{Arc, Mutex};
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
    pub fn close(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut s = self.budget.state.lock().unwrap_or_else(|e| e.into_inner());
        s.records -= 1;
        s.bytes -= self.bytes;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
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
