//! Socket.IO protocol v5 root namespace codec for the LAN event contract.
//! It does not create arbitrary namespaces or application ACK callbacks.
use bottleship_lan_core::wire::{Arg, ServerEvent};
use bytes::Bytes;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    io::{self, Write},
};
pub const MAX_JSON: usize = 16384;
pub const MAX_BINARY: usize = 65552;
pub const MAX_ARGS: usize = 8;
#[derive(Debug, PartialEq)]
pub enum Header {
    Connect(Value),
    Disconnect,
    Event {
        name: String,
        args: Vec<Value>,
        attachments: usize,
    },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodecError(pub &'static str);
pub fn header(s: &str) -> Result<Header, CodecError> {
    if s.is_empty() || s.len() > MAX_JSON {
        return Err(CodecError("Invalid Socket.IO header size"));
    }
    let kind = s.as_bytes()[0];
    let mut rest = &s[1..];
    let mut attachments = 0;
    if kind == b'5' {
        let (n, r) = rest
            .split_once('-')
            .ok_or(CodecError("Missing binary count"))?;
        attachments = n
            .parse::<usize>()
            .ok()
            .filter(|n| *n > 0 && *n <= MAX_ARGS)
            .ok_or(CodecError("Invalid binary count"))?;
        rest = r;
    }
    if rest.starts_with('/') {
        if !rest.starts_with("/,") {
            return Err(CodecError("Unsupported namespace"));
        }
        rest = &rest[2..];
    }
    // An optional client ACK id is parsed but never invented or acknowledged:
    // the reference LAN events have no ACK callback semantics.
    if matches!(kind, b'2' | b'5') {
        rest = rest.trim_start_matches(|c: char| c.is_ascii_digit());
    }
    match kind {
        b'0' => Ok(Header::Connect(if rest.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(rest).map_err(|_| CodecError("Invalid auth JSON"))?
        })),
        b'1' if rest.is_empty() => Ok(Header::Disconnect),
        b'2' | b'5' => {
            let Value::Array(mut values) =
                serde_json::from_str(rest).map_err(|_| CodecError("Invalid event JSON"))?
            else {
                return Err(CodecError("Event is not an array"));
            };
            if values.is_empty() || values.len() > MAX_ARGS + 1 {
                return Err(CodecError("Invalid event arity"));
            }
            let name = values
                .remove(0)
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 64)
                .ok_or(CodecError("Invalid event name"))?
                .to_owned();
            Ok(Header::Event {
                name,
                args: values,
                attachments,
            })
        }
        _ => Err(CodecError("Unsupported Socket.IO packet")),
    }
}
pub fn arguments(args: Vec<Value>, binary: Vec<Bytes>) -> Result<Vec<Arg>, CodecError> {
    let mut seen = vec![false; binary.len()];
    let mut result = Vec::with_capacity(args.len());
    for arg in args {
        if !binary.is_empty() && arg.get("_placeholder") == Some(&Value::Bool(true)) {
            let n = arg
                .get("num")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .filter(|n| *n < binary.len())
                .ok_or(CodecError("Invalid binary placeholder"))?;
            if seen[n] {
                return Err(CodecError("Repeated binary placeholder"));
            }
            seen[n] = true;
            result.push(Arg::Binary(binary[n].clone()));
        } else {
            result.push(Arg::Json(arg))
        }
    }
    if seen.iter().any(|used| !*used) {
        return Err(CodecError("Unused binary attachment"));
    }
    Ok(result)
}
struct Counter(usize, usize);
impl Write for Counter {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_add(b.len())
            .filter(|n| *n <= self.1)
            .ok_or_else(|| io::Error::other("JSON byte budget exceeded"))?;
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub fn json_size(value: &impl Serialize, max: usize) -> Result<usize, CodecError> {
    let mut c = Counter(0, max);
    serde_json::to_writer(&mut c, value).map_err(|_| CodecError("JSON byte budget exceeded"))?;
    Ok(c.0)
}
/// Conservative retained tree estimate (wire length alone is not heap usage).
pub fn retained_json(v: &Value) -> usize {
    let extra = match v {
        Value::String(s) => s.capacity(),
        Value::Array(a) => a
            .capacity()
            .saturating_mul(std::mem::size_of::<Value>())
            .saturating_add(a.iter().map(retained_json).sum::<usize>()),
        Value::Object(m) => m
            .iter()
            .map(|(k, v)| {
                1024usize
                    .saturating_add(k.capacity())
                    .saturating_add(retained_json(v))
            })
            .sum::<usize>(),
        _ => 0,
    };
    128usize.saturating_add(extra)
}
pub fn retained_header(h: &Header) -> usize {
    match h {
        Header::Connect(v) => retained_json(v),
        Header::Event { name, args, .. } => {
            256 + name.capacity()
                + args.capacity() * std::mem::size_of::<Value>()
                + args.iter().map(retained_json).sum::<usize>()
        }
        Header::Disconnect => 128,
    }
}
struct WireEvent<'a>(&'a ServerEvent);
#[derive(Serialize)]
struct Placeholder {
    _placeholder: bool,
    num: u32,
}
impl Serialize for WireEvent<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        match self.0 {
            ServerEvent::Json { name, args } => {
                let mut seq = serializer.serialize_seq(Some(args.len() + 1))?;
                seq.serialize_element(name)?;
                for arg in args {
                    seq.serialize_element(arg)?;
                }
                seq.end()
            }
            ServerEvent::Frame { generation, .. } => {
                let mut seq =
                    serializer.serialize_seq(Some(if generation.is_some() { 3 } else { 2 }))?;
                seq.serialize_element("frame")?;
                seq.serialize_element(&Placeholder {
                    _placeholder: true,
                    num: 0,
                })?;
                if let Some(g) = generation {
                    seq.serialize_element(g)?;
                }
                seq.end()
            }
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Measurement {
    pub logical: usize,
    pub encoded_bound: usize,
}
pub fn measure(event: &ServerEvent) -> Result<Measurement, CodecError> {
    let raw = match event {
        ServerEvent::Frame { bytes, .. } => {
            if bytes.len() > MAX_BINARY {
                return Err(CodecError("Frame too large"));
            }
            bytes.len()
        }
        ServerEvent::Json { name, args } => {
            if name.is_empty() || name.len() > 64 || args.len() > MAX_ARGS {
                return Err(CodecError("Invalid server event"));
            }
            0
        }
    };
    let header = json_size(&WireEvent(event), MAX_JSON)?
        + if matches!(event, ServerEvent::Frame { .. }) {
            3
        } else {
            1
        };
    let encoded_bound = header
        + if matches!(event, ServerEvent::Frame { .. }) {
            raw.div_ceil(3) * 4 + 16
        } else {
            0
        }
        + 32;
    Ok(Measurement {
        logical: if matches!(event, ServerEvent::Frame { .. }) {
            raw
        } else {
            header
        },
        encoded_bound,
    })
}
pub struct Encoded {
    pub header: String,
    pub binary: VecDeque<Bytes>,
}
pub fn encode(event: &ServerEvent) -> Result<Encoded, CodecError> {
    measure(event)?;
    // Serialize borrowed Values only after reservation, without cloning a JSON tree.
    let json =
        serde_json::to_string(&WireEvent(event)).map_err(|_| CodecError("JSON encoding failed"))?;
    let mut binary = VecDeque::new();
    let header = match event {
        ServerEvent::Frame { bytes, .. } => {
            binary.push_back(bytes.clone());
            format!("51-{json}")
        }
        ServerEvent::Json { .. } => format!("2{json}"),
    };
    Ok(Encoded { header, binary })
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn omission_null_and_binary_remain_distinct() {
        let Header::Event { args, .. } = header("2[\"releasePort\",1,2,null]").unwrap() else {
            panic!()
        };
        assert_eq!(arguments(args, vec![]).unwrap().len(), 3);
        let Header::Event { args, .. } =
            header("51-[\"frame\",{\"_placeholder\":true,\"num\":0}]").unwrap()
        else {
            panic!()
        };
        assert_eq!(
            arguments(args, vec![Bytes::from_static(b"abc")]).unwrap(),
            vec![Arg::Binary(Bytes::from_static(b"abc"))]
        );
    }
    #[test]
    fn limits_checked_before_payload_allocation() {
        assert!(header("5999999999999999999999-[]").is_err());
        assert!(header("2/evil,[\"frame\"]").is_err());
        assert!(json_size(&"a".repeat(100), 10).is_err());
        assert!(
            arguments(
                vec![json!({"_placeholder":true,"num":1})],
                vec![Bytes::new()]
            )
            .is_err()
        );
    }
}
