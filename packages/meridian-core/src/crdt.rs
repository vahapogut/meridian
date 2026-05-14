use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::hlc::HlcTimestamp;

/// LWW Register — a single value with an HLC timestamp.
#[wasm_bindgen]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LwwRegister {
    value: JsValue,
    hlc: String,
    node_id: String,
}

#[wasm_bindgen]
impl LwwRegister {
    #[wasm_bindgen(constructor)]
    pub fn new(value: JsValue, hlc: String, node_id: String) -> Self {
        Self { value, hlc, node_id }
    }

    #[wasm_bindgen(getter)]
    pub fn value(&self) -> JsValue { self.value.clone() }

    #[wasm_bindgen(getter)]
    pub fn hlc(&self) -> String { self.hlc.clone() }

    #[wasm_bindgen(getter)]
    pub fn node_id(&self) -> String { self.node_id.clone() }

    /// Merge two LWW registers. The higher HLC wins. Tie-break by nodeId.
    pub fn merge(local: &LwwRegister, remote: &LwwRegister) -> LwwRegister {
        let local_ts = Self::parse_hlc(&local.hlc);
        let remote_ts = Self::parse_hlc(&remote.hlc);

        match local_ts.cmp(&remote_ts) {
            std::cmp::Ordering::Greater => local.clone(),
            std::cmp::Ordering::Less => remote.clone(),
            std::cmp::Ordering::Equal => {
                if local.node_id >= remote.node_id { local.clone() } else { remote.clone() }
            }
        }
    }

    fn parse_hlc(hlc: &str) -> (u64, u16) {
        let parts: Vec<&str> = hlc.split('-').collect();
        let wall = parts.get(0).and_then(|s| s.parse().ok()).unwrap_or(0);
        let counter = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        (wall, counter)
    }
}

/// Result of merging two LWW maps.
#[wasm_bindgen]
pub struct MergeResult {
    #[wasm_bindgen(getter_with_clone)]
    pub merged_map: LwwMap,

    pub conflict_count: u32,
}

/// LWW Map — a document with field-level CRDT registers.
#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct LwwMap {
    fields: HashMap<String, LwwRegister>,
}

#[wasm_bindgen]
impl LwwMap {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self { fields: HashMap::new() }
    }

    pub fn set(&mut self, field: String, value: JsValue, hlc: String, node_id: String) {
        self.fields.insert(field, LwwRegister::new(value, hlc, node_id));
    }

    pub fn get(&self, field: String) -> Option<LwwRegister> {
        self.fields.get(&field).cloned()
    }

    pub fn size(&self) -> usize {
        self.fields.len()
    }

    pub fn keys(&self) -> Vec<String> {
        self.fields.keys().cloned().collect()
    }

    pub fn extract_values(&self) -> JsValue {
        let map = js_sys::Object::new();
        for (key, reg) in &self.fields {
            if key == "__deleted" { continue; }
            js_sys::Reflect::set(&map, &key.into(), &reg.value).ok();
        }
        map.into()
    }

    /// Merge two LWW maps field by field.
    pub fn merge(local: &LwwMap, remote: &LwwMap) -> MergeResult {
        let mut merged = LwwMap::new();
        let mut conflicts = 0u32;

        let all_keys: Vec<String> = {
            let mut keys: Vec<String> = local.fields.keys()
                .chain(remote.fields.keys())
                .cloned()
                .collect();
            keys.sort();
            keys.dedup();
            keys
        };

        for field in all_keys {
            let local_reg = local.fields.get(&field);
            let remote_reg = remote.fields.get(&field);

            match (local_reg, remote_reg) {
                (Some(l), None) => { merged.fields.insert(field, l.clone()); }
                (None, Some(r)) => { merged.fields.insert(field, r.clone()); }
                (Some(l), Some(r)) => {
                    let winner = LwwRegister::merge(l, r);
                    if l.value != r.value { conflicts += 1; }
                    merged.fields.insert(field, winner);
                }
                (None, None) => {}
            }
        }

        MergeResult { merged_map: merged, conflict_count: conflicts }
    }
}
