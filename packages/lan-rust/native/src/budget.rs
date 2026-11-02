use crate::NativeError;
use std::sync::{Arc, Mutex};

#[derive(Default, Clone, Copy, Debug)]
pub(crate) struct Usage {
    pub records: usize,
    pub bytes: usize,
    pub peak_records: usize,
    pub peak_bytes: usize,
    pub closed: bool,
}
pub(crate) struct Budget {
    max_records: usize,
    max_bytes: usize,
    state: Mutex<Usage>,
}
impl Budget {
    pub fn new(max_records: usize, max_bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            max_records,
            max_bytes,
            state: Mutex::new(Usage::default()),
        })
    }
    pub fn reserve(self: &Arc<Self>, bytes: usize) -> Result<Permit, NativeError> {
        self.reserve_many(1, bytes)
    }
    pub fn reserve_many(
        self: &Arc<Self>,
        records: usize,
        bytes: usize,
    ) -> Result<Permit, NativeError> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(NativeError::new(10058, "native binding is closing"));
        }
        if records == 0
            || records > self.max_records.saturating_sub(state.records)
            || bytes > self.max_bytes.saturating_sub(state.bytes)
        {
            return Err(NativeError::new(10055, "native admission window exhausted"));
        }
        state.records += records;
        state.bytes += bytes;
        state.peak_records = state.peak_records.max(state.records);
        state.peak_bytes = state.peak_bytes.max(state.bytes);
        Ok(Permit {
            budget: self.clone(),
            records,
            bytes,
        })
    }
    pub fn close(&self) {
        self.state.lock().unwrap().closed = true;
    }
    pub fn usage(&self) -> Usage {
        *self.state.lock().unwrap()
    }
}
pub(crate) struct Permit {
    budget: Arc<Budget>,
    records: usize,
    bytes: usize,
}
impl Permit {
    pub fn shrink_bytes(&mut self, bytes: usize) {
        assert!(bytes <= self.bytes);
        self.budget.state.lock().unwrap().bytes -= self.bytes - bytes;
        self.bytes = bytes;
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut state = self.budget.state.lock().unwrap();
        state.records -= self.records;
        state.bytes -= self.bytes;
    }
}
