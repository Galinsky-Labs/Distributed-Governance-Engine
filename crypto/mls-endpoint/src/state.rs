//! Private state representation; never exported unwrapped through the Wasm API.
use crate::{bounded, Endpoint, Error, Result, StagedProvider};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::{crypto::OpenMlsCrypto, signatures::Signer, OpenMlsProvider};
use serde::{Deserialize, Serialize};
use std::{cell::Cell, collections::HashMap, marker::PhantomData};
use zeroize::{Zeroize, Zeroizing};

pub(crate) const MAX_STATE: usize = 3_000_000;
const UPSTREAM: &str = "28369d5b48608bef4ddf8371d91503b0f3852bb3";
#[derive(Serialize)]
struct Stored<'a> {
    version: u32,
    upstream: &'a str,
    identity: &'a [u8],
    signer: &'a SignatureKeyPair,
    entries: Vec<(&'a [u8], &'a [u8])>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Loaded {
    version: u32,
    upstream: String,
    identity: Vec<u8>,
    signer: Option<SignatureKeyPair>,
    entries: Vec<(Vec<u8>, Vec<u8>)>,
}
impl Drop for Loaded {
    fn drop(&mut self) {
        for (key, value) in &mut self.entries {
            key.zeroize();
            value.zeroize();
        }
    }
}
struct PendingEntries(HashMap<Vec<u8>, Vec<u8>>);
impl Drop for PendingEntries {
    fn drop(&mut self) {
        for (mut key, mut value) in self.0.drain() {
            key.zeroize();
            value.zeroize();
        }
    }
}
pub(crate) fn encode(endpoint: &Endpoint) -> Result<Zeroizing<Vec<u8>>> {
    let values = endpoint
        .provider
        .storage()
        .values
        .read()
        .map_err(|_| Error::InvalidState)?;
    if values.len() > 20_000
        || values.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() > MAX_STATE
    {
        return Err(Error::InvalidState);
    }
    let mut entries: Vec<_> = values
        .iter()
        .map(|(k, v)| (k.as_slice(), v.as_slice()))
        .collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    let bytes = Zeroizing::new(
        serde_json::to_vec(&Stored {
            version: 1,
            upstream: UPSTREAM,
            identity: endpoint.credential.credential.serialized_content(),
            signer: &endpoint.signer,
            entries,
        })
        .map_err(|_| Error::InvalidState)?,
    );
    if bytes.len() > MAX_STATE {
        return Err(Error::InvalidState);
    }
    Ok(bytes)
}
pub(crate) fn decode(
    bytes: &[u8],
    expected_identity: &[u8],
    expected_key: &[u8],
) -> Result<Endpoint> {
    bounded(bytes, MAX_STATE)?;
    bounded(expected_identity, 512)?;
    if expected_key.len() != 32 {
        return Err(Error::InvalidInput);
    }
    let mut loaded: Loaded = serde_json::from_slice(bytes).map_err(|_| Error::InvalidInput)?;
    if loaded.version != 1
        || loaded.upstream != UPSTREAM
        || loaded.identity != expected_identity
        || loaded.entries.len() > 20_000
    {
        return Err(Error::IdentityMismatch);
    }
    let signer = loaded.signer.take().ok_or(Error::InvalidInput)?;
    if signer.signature_scheme() != SignatureScheme::ED25519 || signer.public() != expected_key {
        return Err(Error::IdentityMismatch);
    }
    let mut staged = StagedProvider(OpenMlsRustCrypto::default());
    let provider = &staged.0;
    // Authenticate private/public consistency rather than trusting serialized public bytes.
    let probe = b"dge-mls-restored-signer-check-v1";
    let signed = signer.sign(probe).map_err(|_| Error::InvalidState)?;
    provider
        .crypto()
        .verify_signature(SignatureScheme::ED25519, probe, expected_key, &signed)
        .map_err(|_| Error::IdentityMismatch)?;
    let mut entries = PendingEntries(HashMap::new());
    for (key, value) in &mut loaded.entries {
        if key.is_empty()
            || key.len() > 4096
            || value.len() > MAX_STATE
            || entries.0.contains_key(key)
        {
            return Err(Error::InvalidInput);
        }
        entries.0.insert(std::mem::take(key), std::mem::take(value));
    }
    *provider
        .storage()
        .values
        .write()
        .map_err(|_| Error::InvalidState)? = std::mem::take(&mut entries.0);
    signer
        .store(provider.storage())
        .map_err(|_| Error::InvalidState)?;
    let credential = CredentialWithKey {
        credential: BasicCredential::new(expected_identity.to_vec()).into(),
        signature_key: expected_key.into(),
    };
    Ok(Endpoint {
        provider: std::mem::take(&mut staged.0),
        signer,
        credential,
        not_sync: PhantomData::<Cell<()>>,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Group, MemberPin, Received};
    #[test]
    fn restored_ratchets_keep_the_next_generation_and_reject_replay() {
        let a = Endpoint::new(b"a-device").unwrap();
        let b = Endpoint::new(b"b-device").unwrap();
        let mut ag = a.create_group(b"scope").unwrap();
        let pins = vec![
            MemberPin {
                identity: b"a-device".to_vec(),
                signature_key: a.signature_key(),
            },
            MemberPin {
                identity: b"b-device".to_vec(),
                signature_key: b.signature_key(),
            },
        ];
        let add = a
            .add(
                &mut ag,
                &b.key_package().unwrap(),
                b"b-device",
                &b.signature_key(),
            )
            .unwrap();
        a.merge_pending(&mut ag).unwrap();
        let mut bg = b.join(&add.welcome, b"scope", &pins).unwrap();
        let first = a.encrypt(&mut ag, b"first").unwrap();
        assert!(matches!(
            b.receive(&mut bg, &first, &pins).unwrap(),
            Received::Application { .. }
        ));
        let a2 = decode(&encode(&a).unwrap(), b"a-device", &a.signature_key()).unwrap();
        let b2 = decode(&encode(&b).unwrap(), b"b-device", &b.signature_key()).unwrap();
        let mut ag2 = Group(
            MlsGroup::load(a2.provider.storage(), &GroupId::from_slice(b"scope"))
                .unwrap()
                .unwrap(),
        );
        let mut bg2 = Group(
            MlsGroup::load(b2.provider.storage(), &GroupId::from_slice(b"scope"))
                .unwrap()
                .unwrap(),
        );
        assert!(b2.receive(&mut bg2, &first, &pins).is_err());
        let second = a2.encrypt(&mut ag2, b"second").unwrap();
        assert!(matches!(
            b2.receive(&mut bg2, &second, &pins).unwrap(),
            Received::Application { .. }
        ));
    }
    #[test]
    fn state_is_versioned_bounded_and_bound_to_the_expected_device() {
        let a = Endpoint::new(b"device").unwrap();
        let key = a.signature_key();
        let bytes = encode(&a).unwrap();
        assert!(decode(&bytes, b"other-device", &key).is_err());
        assert!(decode(&bytes, b"device", &[0; 32]).is_err());
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["version"] = 2.into();
        assert!(decode(&serde_json::to_vec(&value).unwrap(), b"device", &key).is_err());
        assert!(decode(&vec![0; MAX_STATE + 1], b"device", &key).is_err());
        assert!(decode(b"{}", b"device", &key).is_err());
        let mut forged: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let private = forged["signer"]["private"]
            .as_array_mut()
            .expect("signature key storage format changed");
        private[0] = ((private[0].as_u64().unwrap() as u8) ^ 1).into();
        assert!(decode(&serde_json::to_vec(&forged).unwrap(), b"device", &key).is_err());
        let mut duplicate: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let entries = duplicate["entries"].as_array_mut().unwrap();
        entries.push(entries[0].clone());
        assert!(decode(&serde_json::to_vec(&duplicate).unwrap(), b"device", &key).is_err());
    }
}
