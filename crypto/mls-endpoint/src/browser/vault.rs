//! Browser-only checkpoint sealing; no raw private state or wrapping key export.
use super::{invalid, BrowserEndpoint};
use crate::{state, Group};
use js_sys::{Object, Promise, Reflect, Uint8Array};
use openmls::prelude::*;
use openmls_traits::{random::OpenMlsRand, OpenMlsProvider};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use wasm_bindgen::{prelude::*, JsCast};
use wasm_bindgen_futures::{future_to_promise, JsFuture};
use web_sys::{Crypto, CryptoKey};
use zeroize::{Zeroize, Zeroizing};

const MAX_CHECKPOINT: usize = 24_000_000;
const MAX_APPLICATION: usize = 3_000_000;
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Scope {
    tenant_id: String,
    account_id: String,
    device_id: String,
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        })
}
fn aad(scope: &str, generation: u32, identity: &[u8], key: &[u8]) -> Result<Vec<u8>, JsValue> {
    if scope.len() > 512
        || generation == 0
        || identity.is_empty()
        || identity.len() > 512
        || key.len() != 32
    {
        return Err(invalid());
    }
    let scope: Scope = serde_json::from_str(scope).map_err(|_| invalid())?;
    if !uuid(&scope.tenant_id) || !uuid(&scope.account_id) || !uuid(&scope.device_id) {
        return Err(invalid());
    }
    serde_json::to_vec(&("dge-mls-checkpoint-v1", scope, generation, identity, key))
        .map_err(|_| invalid())
}
fn wrapping_key(value: JsValue, usage: &str) -> Result<CryptoKey, JsValue> {
    let key: CryptoKey = value.dyn_into().map_err(|_| invalid())?;
    let algorithm = key.algorithm().map_err(|_| invalid())?;
    let name = Reflect::get(&algorithm, &"name".into())
        .map_err(|_| invalid())?
        .as_string();
    let length = Reflect::get(&algorithm, &"length".into())
        .map_err(|_| invalid())?
        .as_f64();
    if key.type_() != "secret"
        || key.extractable()
        || name.as_deref() != Some("AES-GCM")
        || length != Some(256.0)
        || !key
            .usages()
            .iter()
            .any(|v| v.as_string().as_deref() == Some(usage))
    {
        return Err(invalid());
    }
    Ok(key)
}
fn crypto() -> Result<Crypto, JsValue> {
    Reflect::get(&js_sys::global(), &"crypto".into())
        .map_err(|_| invalid())?
        .dyn_into()
        .map_err(|_| invalid())
}
fn parameters(nonce: &[u8], aad: &[u8]) -> Result<Object, JsValue> {
    let params = Object::new();
    for (key, value) in [
        ("name", JsValue::from_str("AES-GCM")),
        ("iv", Uint8Array::from(nonce).into()),
        ("additionalData", Uint8Array::from(aad).into()),
        ("tagLength", JsValue::from_f64(128.0)),
    ] {
        Reflect::set(&params, &key.into(), &value).map_err(|_| invalid())?;
    }
    Ok(params)
}
#[derive(Serialize)]
struct BorrowedCheckpoint<'a> {
    version: u32,
    endpoint: &'a str,
    groups: Vec<(u32, Vec<u8>)>,
    next: u32,
    packages: u32,
    application: &'a [u8],
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LoadedCheckpoint {
    version: u32,
    endpoint: String,
    groups: Vec<(u32, Vec<u8>)>,
    next: u32,
    packages: u32,
    application: Vec<u8>,
}
impl Drop for LoadedCheckpoint {
    fn drop(&mut self) {
        self.endpoint.zeroize();
        self.application.zeroize();
    }
}
#[wasm_bindgen]
pub struct SealedCheckpoint {
    generation: u32,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}
#[wasm_bindgen]
impl SealedCheckpoint {
    #[wasm_bindgen(getter)]
    pub fn generation(&self) -> u32 {
        self.generation
    }
    #[wasm_bindgen(getter)]
    pub fn nonce(&self) -> Vec<u8> {
        self.nonce.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn ciphertext(&self) -> Vec<u8> {
        self.ciphertext.clone()
    }
}
#[wasm_bindgen]
pub struct OpenedCheckpoint {
    endpoint: Option<BrowserEndpoint>,
    application: Vec<u8>,
}
impl Drop for OpenedCheckpoint {
    fn drop(&mut self) {
        self.application.zeroize();
    }
}
#[wasm_bindgen]
impl OpenedCheckpoint {
    #[wasm_bindgen(js_name=takeEndpoint)]
    pub fn take_endpoint(&mut self) -> Result<BrowserEndpoint, JsValue> {
        self.endpoint.take().ok_or_else(invalid)
    }
    #[wasm_bindgen(getter,js_name=applicationState)]
    pub fn application_state(&self) -> Vec<u8> {
        self.application.clone()
    }
}
#[wasm_bindgen]
impl BrowserEndpoint {
    /// Capture synchronously, then encrypt without retaining a borrow of the
    /// endpoint across the browser's asynchronous crypto operation. The durable
    /// coordinator must serialize changes and commit before releasing wire data.
    #[wasm_bindgen(js_name=sealCheckpoint)]
    pub fn seal_checkpoint(
        &self,
        key: JsValue,
        scope: &str,
        generation: u32,
        application: &[u8],
    ) -> Result<Promise, JsValue> {
        let key = wrapping_key(key, "encrypt")?;
        if application.len() > MAX_APPLICATION {
            return Err(invalid());
        }
        let aad = aad(
            scope,
            generation,
            self.inner.credential.credential.serialized_content(),
            self.inner.signer.public(),
        )?;
        let mut endpoint_bytes = state::encode(&self.inner).map_err(|_| invalid())?;
        let endpoint_json = Zeroizing::new(
            String::from_utf8(std::mem::take(&mut *endpoint_bytes)).map_err(|_| invalid())?,
        );
        let groups = self
            .groups
            .iter()
            .map(|(id, group)| (*id, group.0.group_id().as_slice().to_vec()))
            .collect();
        let plain = Zeroizing::new(
            serde_json::to_vec(&BorrowedCheckpoint {
                version: 1,
                endpoint: &endpoint_json,
                groups,
                next: self.next,
                packages: self.packages,
                application,
            })
            .map_err(|_| invalid())?,
        );
        if plain.len() > MAX_CHECKPOINT {
            return Err(invalid());
        }
        let nonce = self
            .inner
            .provider
            .rand()
            .random_vec(12)
            .map_err(|_| invalid())?;
        Ok(future_to_promise(async move {
            let params = parameters(&nonce, &aad)?;
            let promise = crypto()?
                .subtle()
                .encrypt_with_object_and_u8_array(&params, &key, &plain)
                .map_err(|_| invalid())?;
            let bytes = JsFuture::from(promise).await.map_err(|_| invalid())?;
            let ciphertext = Uint8Array::new(&bytes).to_vec();
            Ok(SealedCheckpoint {
                generation,
                nonce,
                ciphertext,
            }
            .into())
        }))
    }
    /// expected_generation is a trusted local continuity value, not the
    /// generation claimed by an untrusted ciphertext record or backup.
    #[wasm_bindgen(js_name=restoreCheckpoint)]
    pub fn restore_checkpoint(
        key: JsValue,
        scope: &str,
        expected_generation: u32,
        nonce: &[u8],
        ciphertext: &[u8],
        identity: &[u8],
        signature_key: &[u8],
    ) -> Result<Promise, JsValue> {
        let key = wrapping_key(key, "decrypt")?;
        if nonce.len() != 12 || ciphertext.len() < 16 || ciphertext.len() > MAX_CHECKPOINT + 16 {
            return Err(invalid());
        }
        let aad = aad(scope, expected_generation, identity, signature_key)?;
        let nonce = nonce.to_vec();
        let ciphertext = ciphertext.to_vec();
        let identity = identity.to_vec();
        let signature_key = signature_key.to_vec();
        Ok(future_to_promise(async move {
            let params = parameters(&nonce, &aad)?;
            let promise = crypto()?
                .subtle()
                .decrypt_with_object_and_u8_array(&params, &key, &ciphertext)
                .map_err(|_| invalid())?;
            let bytes = JsFuture::from(promise).await.map_err(|_| invalid())?;
            let decrypted = Uint8Array::new(&bytes);
            let plain = Zeroizing::new(decrypted.to_vec());
            decrypted.fill(0, 0, decrypted.length());
            let mut checkpoint: LoadedCheckpoint =
                serde_json::from_slice(&plain).map_err(|_| invalid())?;
            if checkpoint.version != 1
                || checkpoint.groups.len() > 32
                || checkpoint.packages > 128
                || checkpoint.application.len() > MAX_APPLICATION
                || checkpoint.next == 0
            {
                return Err(invalid());
            }
            let inner = state::decode(checkpoint.endpoint.as_bytes(), &identity, &signature_key)
                .map_err(|_| invalid())?;
            let mut groups = BTreeMap::new();
            let mut scopes = std::collections::HashSet::new();
            for (handle, id) in &checkpoint.groups {
                if *handle == 0
                    || *handle >= checkpoint.next
                    || id.is_empty()
                    || id.len() > 512
                    || !scopes.insert(id.clone())
                {
                    return Err(invalid());
                }
                let group = Group(
                    MlsGroup::load(inner.provider.storage(), &GroupId::from_slice(id))
                        .map_err(|_| invalid())?
                        .ok_or_else(invalid)?,
                );
                // Inactive evicted groups may have no own leaf, but are never
                // restored as usable senders. Active groups must match this device.
                if group.active() {
                    inner.own(&group).map_err(|_| invalid())?;
                }
                if groups.insert(*handle, group).is_some() {
                    return Err(invalid());
                }
            }
            let endpoint = BrowserEndpoint {
                inner,
                groups,
                next: checkpoint.next,
                packages: checkpoint.packages,
            };
            Ok(OpenedCheckpoint {
                endpoint: Some(endpoint),
                application: std::mem::take(&mut checkpoint.application),
            }
            .into())
        }))
    }
}
