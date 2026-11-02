//! Fair admission into the one ordered core lane.
use tokio::{
    sync::{mpsc, watch},
    time::Interval,
};
pub(crate) enum Selected<W, E> {
    Wire(Option<W>),
    Event(Option<E>),
    Tick,
    Stop,
}
pub(crate) async fn next<W, E>(
    wire: &mut mpsc::Receiver<W>,
    events: &mut mpsc::Receiver<E>,
    tick: &mut Interval,
    stopping: &mut watch::Receiver<bool>,
    turn: u8,
) -> Selected<W, E> {
    // Every continuously ready class gets first choice once in three turns.
    // Stop always takes precedence; stochastic select fairness is not required.
    match turn % 3 {
        0 => tokio::select! {
            biased;
            _=stopping.changed()=>Selected::Stop,
            value=wire.recv()=>Selected::Wire(value),
            value=events.recv()=>Selected::Event(value),
            _=tick.tick()=>Selected::Tick,
        },
        1 => tokio::select! {
            biased;
            _=stopping.changed()=>Selected::Stop,
            value=events.recv()=>Selected::Event(value),
            _=tick.tick()=>Selected::Tick,
            value=wire.recv()=>Selected::Wire(value),
        },
        _ => tokio::select! {
            biased;
            _=stopping.changed()=>Selected::Stop,
            _=tick.tick()=>Selected::Tick,
            value=wire.recv()=>Selected::Wire(value),
            value=events.recv()=>Selected::Event(value),
        },
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn sustained_wire_traffic_cannot_starve_native_events_or_expiration() {
        let (wire, mut rx) = mpsc::channel(256);
        let (events, mut erx) = mpsc::channel(256);
        let (stop, mut stopping) = watch::channel(false);
        for n in 0..128 {
            wire.try_send(n).unwrap();
            events.try_send(n).unwrap();
        }
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
        // Register the timer and let the driver mark the next tick ready before
        // counting scheduler turns; a wall-clock deadline alone is not readiness.
        tick.tick().await;
        tick.reset_immediately();
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        let mut last_event = 0;
        let mut first_tick = None;
        let mut wires = 0;
        let mut native = 0;
        for turn in 0..18 {
            match next(
                &mut rx,
                &mut erx,
                &mut tick,
                &mut stopping,
                (turn % 3) as u8,
            )
            .await
            {
                Selected::Wire(Some(_)) => wires += 1,
                Selected::Event(Some(_)) => {
                    assert!(turn - last_event <= 3, "Native completion starvation");
                    last_event = turn;
                    native += 1;
                }
                Selected::Tick => {
                    first_tick.get_or_insert(turn);
                }
                _ => panic!("Unexpected closure"),
            }
        }
        assert!(
            wires > 0 && native >= 5,
            "Both admitted network classes must make progress"
        );
        assert!(
            first_tick.is_some_and(|turn| turn < 3),
            "Due expiration must run within three turns"
        );
        stop.send(true).unwrap();
        assert!(matches!(
            next(&mut rx, &mut erx, &mut tick, &mut stopping, 0).await,
            Selected::Stop
        ));
    }
}
