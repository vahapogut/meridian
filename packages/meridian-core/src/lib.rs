//! # Meridian Core — Rust WASM CRDT Engine
//!
//! High-performance HLC + LWW CRDT primitives compiled to WebAssembly.
//! Used by the TypeScript client for compute-intensive merge operations.
//!
//! ## Building
//! ```bash
//! cd packages/meridian-core
//! wasm-pack build --target web
//! ```
//!
//! ## Usage from JavaScript
//! ```js
//! import init, { HlcClock, LwwMap } from './meridian_core.js';
//! await init();
//!
//! const clock = new HlcClock("node-1");
//! const ts = clock.now();
//! ```

mod hlc;
mod crdt;

pub use hlc::{HlcClock, HlcTimestamp};
pub use crdt::{LwwMap, LwwRegister, MergeResult};
