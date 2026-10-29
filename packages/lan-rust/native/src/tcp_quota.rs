//! Non-reserving shared TCP socket quota. A waiting listener owns no slot.
//! Registration and release share one lock, so a release cannot pass a waiter
//! between its availability check and waker registration.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
};

struct State {
    used: usize,
    closed: bool,
    next_waiter: u64,
    waiters: HashMap<u64, Waker>,
}
pub struct TcpQuota {
    limit: usize,
    state: Mutex<State>,
}
pub struct TcpQuotaPermit {
    quota: Arc<TcpQuota>,
}
pub(crate) struct TcpQuotaWaiter {
    quota: Arc<TcpQuota>,
    id: u64,
}
impl TcpQuota {
    pub fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self { limit, state: Mutex::new(State { used: 0, closed: false, next_waiter: 0, waiters: HashMap::new() }) })
    }
    pub fn try_acquire(self: &Arc<Self>) -> Option<TcpQuotaPermit> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed || state.used >= self.limit { return None; }
        state.used += 1;
        Some(TcpQuotaPermit { quota: self.clone() })
    }
    pub(crate) fn waiter(self: &Arc<Self>) -> Option<TcpQuotaWaiter> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed { return None; }
        state.next_waiter = state.next_waiter.checked_add(1)?;
        Some(TcpQuotaWaiter { quota: self.clone(), id: state.next_waiter })
    }
    pub fn available(&self) -> usize {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.limit.saturating_sub(state.used)
    }
    pub fn close(&self) {
        let wakes = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.closed = true;
            std::mem::take(&mut state.waiters)
        };
        for (_, wake) in wakes { wake.wake(); }
    }
}
impl TcpQuotaWaiter {
    /// Called only by the native listener driver with Tokio's task waker.
    /// The probe is nonblocking and must not re-enter this quota.
    pub(crate) fn poll_accept<T>(
        &self,
        cx: &mut Context<'_>,
        probe: impl FnOnce(&mut Context<'_>) -> Poll<std::io::Result<T>>,
    ) -> Poll<std::io::Result<(T, TcpQuotaPermit)>> {
        // Clone and release wakers outside the mutex: RawWaker implementations
        // may run arbitrary code on clone/drop.
        let waker = cx.waker().clone();
        let mut state = self.quota.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            let old = state.waiters.remove(&self.id);
            drop(state); drop(old);
            return Poll::Ready(Err(std::io::Error::other("TCP quota closed")));
        }
        if state.used >= self.quota.limit {
            if !state.waiters.contains_key(&self.id) && state.waiters.len() >= 64 {
                drop(state);
                return Poll::Ready(Err(std::io::Error::other("TCP quota waiter limit reached")));
            }
            let old = state.waiters.insert(self.id, waker);
            drop(state); drop(old);
            return Poll::Pending;
        }
        let old = state.waiters.remove(&self.id);
        let result = match probe(cx) {
            Poll::Ready(Ok(value)) => {
                state.used += 1;
                Poll::Ready(Ok((value, TcpQuotaPermit { quota: self.quota.clone() })))
            }
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Pending => Poll::Pending,
        };
        drop(state); drop(old); drop(waker);
        result
    }
    #[cfg(test)]
    fn poll_acquire(&self, cx: &mut Context<'_>) -> Poll<Option<TcpQuotaPermit>> {
        match self.poll_accept(cx, |_| Poll::Ready(Ok(()))) {
            Poll::Ready(Ok(((), permit))) => Poll::Ready(Some(permit)),
            Poll::Ready(Err(_)) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}
impl Drop for TcpQuotaWaiter {
    fn drop(&mut self) {
        let old = self.quota.state.lock().unwrap_or_else(|e| e.into_inner()).waiters.remove(&self.id);
        drop(old);
    }
}
impl Drop for TcpQuotaPermit {
    fn drop(&mut self) {
        let wakes = {
            let mut state = self.quota.state.lock().unwrap_or_else(|e| e.into_inner());
            debug_assert!(state.used > 0);
            state.used -= 1;
            std::mem::take(&mut state.waiters)
        };
        for (_, wake) in wakes { wake.wake(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Barrier, atomic::{AtomicUsize, Ordering}};
    use std::task::Wake;

    struct Counter(AtomicUsize);
    impl Wake for Counter {
        fn wake(self: Arc<Self>) { self.0.fetch_add(1, Ordering::SeqCst); }
        fn wake_by_ref(self: &Arc<Self>) { self.0.fetch_add(1, Ordering::SeqCst); }
    }

    #[test]
    fn release_racing_registration_cannot_lose_wake_and_cancel_deregisters() {
        for _ in 0..1000 {
            let quota = TcpQuota::new(1);
            let permit = quota.try_acquire().unwrap();
            let waiter = quota.waiter().unwrap();
            let counter = Arc::new(Counter(AtomicUsize::new(0)));
            let waker = Waker::from(counter.clone());
            let barrier = Arc::new(Barrier::new(2));
            let thread_barrier = barrier.clone();
            let worker = std::thread::spawn(move || { thread_barrier.wait(); drop(permit); });
            barrier.wait();
            let result = waiter.poll_acquire(&mut Context::from_waker(&waker));
            worker.join().unwrap();
            match result {
                Poll::Pending => {
                    assert!(counter.0.load(Ordering::SeqCst) > 0);
                    assert_eq!(quota.available(), 1);
                    assert!(matches!(waiter.poll_acquire(&mut Context::from_waker(&waker)), Poll::Ready(Some(_))));
                }
                Poll::Ready(Some(permit)) => drop(permit),
                Poll::Ready(None) => panic!("unexpected close"),
            }
            let held = quota.try_acquire().unwrap();
            assert!(matches!(waiter.poll_acquire(&mut Context::from_waker(&waker)), Poll::Pending));
            drop(waiter);
            assert!(quota.state.lock().unwrap().waiters.is_empty());
            drop(held);
        }
    }
    #[test]
    fn idle_probe_is_atomic_with_outbound_admission() {
        let quota = TcpQuota::new(1);
        let waiter = quota.waiter().unwrap();
        let counter = Arc::new(Counter(AtomicUsize::new(0)));
        let barrier = Arc::new(Barrier::new(2));
        let probe_barrier = barrier.clone();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let probe_thread = std::thread::spawn(move || {
            let waker = Waker::from(counter);
            let result: Poll<std::io::Result<((), TcpQuotaPermit)>> = waiter.poll_accept(
                &mut Context::from_waker(&waker),
                |_| {
                    entered_tx.send(()).unwrap();
                    probe_barrier.wait();
                    Poll::Pending
                },
            );
            assert!(matches!(result, Poll::Pending));
        });
        entered_rx.recv().unwrap();
        assert!(quota.state.try_lock().is_err(), "probe must hold the admission lock");
        let probe_quota = quota.clone();
        let (attempt_tx, attempt_rx) = std::sync::mpsc::channel();
        let outbound = std::thread::spawn(move || {
            attempt_tx.send(()).unwrap();
            probe_quota.try_acquire()
        });
        attempt_rx.recv().unwrap();
        barrier.wait();
        probe_thread.join().unwrap();
        let permit = outbound.join().unwrap().expect("idle probe caused false quota refusal");
        drop(permit);
        assert_eq!(quota.available(), 1);
    }
    #[test]
    fn successful_probe_holds_capacity_until_permit_drop() {
        let quota = TcpQuota::new(1);
        let waiter = quota.waiter().unwrap();
        let counter = Arc::new(Counter(AtomicUsize::new(0)));
        let waker = Waker::from(counter);
        let permit = match waiter.poll_accept(&mut Context::from_waker(&waker), |_| Poll::Ready(Ok(()))) {
            Poll::Ready(Ok(((), permit))) => permit,
            _ => panic!("expected ready probe"),
        };
        assert!(quota.try_acquire().is_none());
        drop(permit);
        assert!(quota.try_acquire().is_some());
    }
    #[test]
    fn concurrent_acquisition_never_exceeds_limit_and_all_threads_progress() {
        let quota = TcpQuota::new(2);
        let live = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(8));
        let mut threads = Vec::new();
        for _ in 0..8 {
            let quota = quota.clone();
            let live = live.clone();
            let barrier = barrier.clone();
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                for _ in 0..500 {
                    let permit = loop {
                        if let Some(permit) = quota.try_acquire() { break permit; }
                        std::thread::yield_now();
                    };
                    assert!(live.fetch_add(1, Ordering::SeqCst) < 2);
                    std::thread::yield_now();
                    live.fetch_sub(1, Ordering::SeqCst);
                    drop(permit);
                }
            }));
        }
        for thread in threads { thread.join().unwrap(); }
        assert_eq!(live.load(Ordering::SeqCst), 0);
        assert_eq!(quota.available(), 2);
    }
    #[test]
    fn close_wakes_waiters_and_prevents_new_acquisition() {
        let quota = TcpQuota::new(1);
        let held = quota.try_acquire().unwrap();
        let waiter = quota.waiter().unwrap();
        let counter = Arc::new(Counter(AtomicUsize::new(0)));
        let waker = Waker::from(counter.clone());
        assert!(matches!(waiter.poll_acquire(&mut Context::from_waker(&waker)), Poll::Pending));
        quota.close();
        assert_eq!(counter.0.load(Ordering::SeqCst), 1);
        drop(held);
        assert!(matches!(waiter.poll_acquire(&mut Context::from_waker(&waker)), Poll::Ready(None)));
        assert!(quota.try_acquire().is_none());
    }
}
