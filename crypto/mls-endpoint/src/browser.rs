//! Narrow browser bindings: protocol state and private keys never cross this API.
mod vault;
use crate::{Endpoint, Group, MemberPin, Received};
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

fn error(_: crate::Error) -> JsValue {
    JsValue::from_str("MLS_OPERATION_REJECTED")
}
fn invalid() -> JsValue {
    JsValue::from_str("MLS_OPERATION_REJECTED")
}
fn roster(json: &str) -> Result<Vec<MemberPin>, JsValue> {
    if json.len() > 1_000_000 {
        return Err(invalid());
    }
    let pins: Vec<MemberPin> = serde_json::from_str(json).map_err(|_| invalid())?;
    if pins.is_empty() || pins.len() > 1000 {
        return Err(invalid());
    }
    Ok(pins)
}
#[wasm_bindgen]
pub struct BrowserEndpoint {
    inner: Endpoint,
    groups: BTreeMap<u32, Group>,
    next: u32,
    packages: u32,
}
#[wasm_bindgen]
pub struct MembershipMessages {
    commit: Vec<u8>,
    welcome: Vec<u8>,
}
#[wasm_bindgen]
impl MembershipMessages {
    #[wasm_bindgen(getter)]
    pub fn commit(&self) -> Vec<u8> {
        self.commit.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn welcome(&self) -> Vec<u8> {
        self.welcome.clone()
    }
}
#[wasm_bindgen]
pub struct Delivery {
    application: bool,
    sender: Vec<u8>,
    bytes: Vec<u8>,
}
impl Drop for Delivery {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.bytes.zeroize();
    }
}
#[wasm_bindgen]
impl Delivery {
    #[wasm_bindgen(getter)]
    pub fn application(&self) -> bool {
        self.application
    }
    #[wasm_bindgen(getter)]
    pub fn sender(&self) -> Vec<u8> {
        self.sender.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }
}
impl BrowserEndpoint {
    fn insert(&mut self, group: Group) -> Result<u32, JsValue> {
        if self.groups.len() >= 32 {
            return Err(invalid());
        }
        let id = self.next;
        self.next = self.next.checked_add(1).ok_or_else(invalid)?;
        self.groups.insert(id, group);
        Ok(id)
    }
}
#[wasm_bindgen]
impl BrowserEndpoint {
    #[wasm_bindgen(constructor)]
    pub fn new(identity: &[u8]) -> Result<BrowserEndpoint, JsValue> {
        Ok(Self {
            inner: Endpoint::new(identity).map_err(error)?,
            groups: BTreeMap::new(),
            next: 1,
            packages: 0,
        })
    }
    #[wasm_bindgen(js_name=signatureKey)]
    pub fn signature_key(&self) -> Vec<u8> {
        self.inner.signature_key()
    }
    #[wasm_bindgen(js_name=keyPackage)]
    pub fn key_package(&mut self) -> Result<Vec<u8>, JsValue> {
        if self.packages >= 128 {
            return Err(invalid());
        }
        let package = self.inner.key_package().map_err(error)?;
        self.packages += 1;
        Ok(package)
    }
    #[wasm_bindgen(js_name=createGroup)]
    pub fn create_group(&mut self, id: &[u8]) -> Result<u32, JsValue> {
        if self.groups.len() >= 32 {
            return Err(invalid());
        }
        if self
            .groups
            .values()
            .any(|group| group.0.group_id().as_slice() == id)
        {
            return Err(invalid());
        }
        let group = self.inner.create_group(id).map_err(error)?;
        self.insert(group)
    }
    pub fn join(&mut self, welcome: &[u8], id: &[u8], pins: &str) -> Result<u32, JsValue> {
        if self.groups.len() >= 32
            || self
                .groups
                .values()
                .any(|group| group.0.group_id().as_slice() == id)
        {
            return Err(invalid());
        }
        let group = self
            .inner
            .join(welcome, id, &roster(pins)?)
            .map_err(error)?;
        self.insert(group)
    }
    pub fn add(
        &mut self,
        id: u32,
        package: &[u8],
        identity: &[u8],
        key: &[u8],
    ) -> Result<MembershipMessages, JsValue> {
        let group = self.groups.get_mut(&id).ok_or_else(invalid)?;
        let added = self
            .inner
            .add(group, package, identity, key)
            .map_err(error)?;
        Ok(MembershipMessages {
            commit: added.commit,
            welcome: added.welcome,
        })
    }
    pub fn remove(&mut self, id: u32, identity: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.inner
            .remove(self.groups.get_mut(&id).ok_or_else(invalid)?, identity)
            .map_err(error)
    }
    #[wasm_bindgen(js_name=mergePending)]
    pub fn merge_pending(&mut self, id: u32) -> Result<(), JsValue> {
        self.inner
            .merge_pending(self.groups.get_mut(&id).ok_or_else(invalid)?)
            .map_err(error)
    }
    pub fn encrypt(&mut self, id: u32, bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.inner
            .encrypt(self.groups.get_mut(&id).ok_or_else(invalid)?, bytes)
            .map_err(error)
    }
    pub fn receive(&mut self, id: u32, bytes: &[u8], pins: &str) -> Result<Delivery, JsValue> {
        match self
            .inner
            .receive(
                self.groups.get_mut(&id).ok_or_else(invalid)?,
                bytes,
                &roster(pins)?,
            )
            .map_err(error)?
        {
            Received::Application { sender, bytes } => Ok(Delivery {
                application: true,
                sender,
                bytes,
            }),
            Received::Commit => Ok(Delivery {
                application: false,
                sender: vec![],
                bytes: vec![],
            }),
        }
    }
    #[wasm_bindgen(js_name=groupInventory)]
    pub fn group_inventory(&self) -> Result<String, JsValue> {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Metadata {
            handle: u32,
            id: Vec<u8>,
            epoch: String,
            active: bool,
            pending_commit: bool,
        }
        let items: Vec<_> = self
            .groups
            .iter()
            .map(|(handle, group)| Metadata {
                handle: *handle,
                id: group.0.group_id().as_slice().to_vec(),
                epoch: group.epoch().to_string(),
                active: group.active(),
                pending_commit: group.0.pending_commit().is_some(),
            })
            .collect();
        serde_json::to_string(&items).map_err(|_| invalid())
    }
    pub fn epoch(&self, id: u32) -> Result<u64, JsValue> {
        Ok(self.groups.get(&id).ok_or_else(invalid)?.epoch())
    }
    pub fn active(&self, id: u32) -> Result<bool, JsValue> {
        Ok(self.groups.get(&id).ok_or_else(invalid)?.active())
    }
    pub fn close(&mut self, id: u32) -> Result<(), JsValue> {
        use openmls_traits::OpenMlsProvider;
        let mut group = self.groups.remove(&id).ok_or_else(invalid)?;
        group
            .0
            .delete(self.inner.provider.storage())
            .map_err(|_| invalid())
    }
}
