use wasm_bindgen::prelude::*;
use std::cmp::Ordering;

/// Hybrid Logical Clock timestamp.
#[wasm_bindgen]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HlcTimestamp {
    pub wall_time: u64,
    pub counter: u16,
    pub node_id: String,
}

#[wasm_bindgen]
impl HlcTimestamp {
    #[wasm_bindgen(constructor)]
    pub fn new(wall_time: u64, counter: u16, node_id: String) -> Self {
        Self { wall_time, counter, node_id }
    }

    pub fn serialize(&self) -> String {
        format!("{:020}-{:04}-{}", self.wall_time, self.counter, self.node_id)
    }

    pub fn compare(&self, other: &HlcTimestamp) -> i32 {
        match self.wall_time.cmp(&other.wall_time) {
            Ordering::Equal => match self.counter.cmp(&other.counter) {
                Ordering::Equal => self.node_id.cmp(&other.node_id) as i32,
                other => other as i32,
            },
            other => other as i32,
        }
    }
}

/// Hybrid Logical Clock for generating causally ordered timestamps.
#[wasm_bindgen]
pub struct HlcClock {
    wall_time: u64,
    counter: u16,
    node_id: String,
}

#[wasm_bindgen]
impl HlcClock {
    #[wasm_bindgen(constructor)]
    pub fn new(node_id: String) -> Self {
        Self { wall_time: 0, counter: 0, node_id }
    }

    fn get_time_ms() -> u64 {
        js_sys::Date::now() as u64
    }

    pub fn now(&mut self) -> HlcTimestamp {
        let physical = Self::get_time_ms();

        if physical > self.wall_time {
            self.wall_time = physical;
            self.counter = 0;
        } else {
            self.counter = self.counter.wrapping_add(1);
        }

        HlcTimestamp {
            wall_time: self.wall_time,
            counter: self.counter,
            node_id: self.node_id.clone(),
        }
    }

    pub fn recv(&mut self, remote: &HlcTimestamp) -> HlcTimestamp {
        let physical = Self::get_time_ms();

        if physical > self.wall_time && physical > remote.wall_time {
            self.wall_time = physical;
            self.counter = 0;
        } else if remote.wall_time > self.wall_time {
            self.wall_time = remote.wall_time;
            self.counter = remote.counter.wrapping_add(1);
        } else if self.wall_time > remote.wall_time {
            self.counter = self.counter.wrapping_add(1);
        } else {
            self.counter = self.counter.max(remote.counter).wrapping_add(1);
        }

        HlcTimestamp {
            wall_time: self.wall_time,
            counter: self.counter,
            node_id: self.node_id.clone(),
        }
    }

    pub fn peek(&self) -> HlcTimestamp {
        HlcTimestamp {
            wall_time: self.wall_time,
            counter: self.counter,
            node_id: self.node_id.clone(),
        }
    }
}
