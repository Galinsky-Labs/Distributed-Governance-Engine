//! Endpoint-only RFC 9420 integration. Never link into the server runtime.
//! Credential/account authorization is a separate verified-device boundary.
#[cfg(target_arch = "wasm32")]
mod browser;
#[cfg(any(test, target_arch = "wasm32"))]
mod state;
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::{types::Ciphersuite, OpenMlsProvider};
use std::{cell::Cell, marker::PhantomData};
use tls_codec::{Deserialize, Serialize};
use zeroize::Zeroize;

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
const MAX_WIRE: usize = 2_000_000;
const MAX_PLAINTEXT: usize = 1_000_000;

/// Errors intentionally omit protocol data, credentials, keys and plaintext.
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    InvalidInput,
    InvalidProtocol,
    IdentityMismatch,
    InvalidState,
}
pub type Result<T> = std::result::Result<T, Error>;

pub struct Endpoint {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    not_sync: PhantomData<Cell<()>>,
}
pub struct Group(MlsGroup);
fn wipe_storage(provider: &OpenMlsRustCrypto) {
    if let Ok(mut values) = provider.storage().values.write() {
        for (mut key, mut value) in values.drain() {
            key.zeroize();
            value.zeroize();
        }
    }
}
struct StagedProvider(OpenMlsRustCrypto);
impl Drop for StagedProvider {
    fn drop(&mut self) {
        wipe_storage(&self.0);
    }
}
impl Drop for Endpoint {
    fn drop(&mut self) {
        wipe_storage(&self.provider);
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemberPin {
    pub identity: Vec<u8>,
    pub signature_key: Vec<u8>,
}
fn pins_match(mut actual: Vec<MemberPin>, expected: &[MemberPin]) -> Result<()> {
    if expected.is_empty() || expected.len() > 1000 {
        return Err(Error::InvalidInput);
    }
    let mut pins = expected.to_vec();
    let unique_keys: std::collections::HashSet<_> =
        pins.iter().map(|pin| &pin.signature_key).collect();
    if unique_keys.len() != pins.len() {
        return Err(Error::IdentityMismatch);
    }
    for pin in &pins {
        bounded(&pin.identity, 512)?;
        if pin.signature_key.len() != 32 {
            return Err(Error::InvalidInput);
        }
    }
    actual.sort();
    pins.sort();
    if pins.windows(2).any(|p| p[0].identity == p[1].identity) || actual != pins {
        return Err(Error::IdentityMismatch);
    }
    Ok(())
}
pub struct Addition {
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
}
pub enum Received {
    Application { sender: Vec<u8>, bytes: Vec<u8> },
    Commit,
}

fn bounded(bytes: &[u8], max: usize) -> Result<()> {
    if bytes.is_empty() || bytes.len() > max {
        return Err(Error::InvalidInput);
    }
    Ok(())
}
fn wire(message: &MlsMessageOut) -> Result<Vec<u8>> {
    message
        .tls_serialize_detached()
        .map_err(|_| Error::InvalidProtocol)
}
fn message(bytes: &[u8]) -> Result<MlsMessageIn> {
    bounded(bytes, MAX_WIRE)?;
    MlsMessageIn::tls_deserialize_exact(bytes).map_err(|_| Error::InvalidProtocol)
}
impl Endpoint {
    fn own(&self, group: &Group) -> Result<()> {
        let leaf = group.0.own_leaf().ok_or(Error::InvalidState)?;
        if leaf.credential() != &self.credential.credential
            || leaf.signature_key().as_slice() != self.signer.public()
        {
            return Err(Error::IdentityMismatch);
        }
        Ok(())
    }
    fn stage(&self) -> Result<StagedProvider> {
        let staged = StagedProvider(OpenMlsRustCrypto::default());
        *staged
            .0
            .storage()
            .values
            .write()
            .map_err(|_| Error::InvalidState)? = self
            .provider
            .storage()
            .values
            .read()
            .map_err(|_| Error::InvalidState)?
            .clone();
        Ok(staged)
    }
    fn promote(&self, staged: &StagedProvider) -> Result<()> {
        let next = std::mem::take(
            &mut *staged
                .0
                .storage()
                .values
                .write()
                .map_err(|_| Error::InvalidState)?,
        );
        let mut old = std::mem::replace(
            &mut *self
                .provider
                .storage()
                .values
                .write()
                .map_err(|_| Error::InvalidState)?,
            next,
        );
        for (mut key, mut value) in old.drain() {
            key.zeroize();
            value.zeroize();
        }
        Ok(())
    }
    /// Identity bytes must come from the application's verified device binding,
    /// never an email address or a user-entered display name.
    pub fn new(identity: &[u8]) -> Result<Self> {
        bounded(identity, 512)?;
        let provider = OpenMlsRustCrypto::default();
        let signer =
            SignatureKeyPair::new(SignatureScheme::ED25519).map_err(|_| Error::InvalidState)?;
        signer
            .store(provider.storage())
            .map_err(|_| Error::InvalidState)?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.to_vec()).into(),
            signature_key: signer.public().into(),
        };
        Ok(Self {
            provider,
            signer,
            credential,
            not_sync: PhantomData,
        })
    }
    pub fn signature_key(&self) -> Vec<u8> {
        self.signer.public().to_vec()
    }
    pub fn key_package(&self) -> Result<Vec<u8>> {
        let bundle = KeyPackage::builder()
            .build(SUITE, &self.provider, &self.signer, self.credential.clone())
            .map_err(|_| Error::InvalidProtocol)?;
        bundle
            .key_package()
            .tls_serialize_detached()
            .map_err(|_| Error::InvalidProtocol)
    }
    pub fn create_group(&self, group_id: &[u8]) -> Result<Group> {
        bounded(group_id, 512)?;
        if MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id))
            .map_err(|_| Error::InvalidState)?
            .is_some()
        {
            return Err(Error::InvalidState);
        }
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(SUITE)
            .use_ratchet_tree_extension(true)
            .padding_size(256)
            .max_past_epochs(0)
            .build();
        MlsGroup::new_with_group_id(
            &self.provider,
            &self.signer,
            &config,
            GroupId::from_slice(group_id),
            self.credential.clone(),
        )
        .map(Group)
        .map_err(|_| Error::InvalidProtocol)
    }
    pub fn join(
        &self,
        welcome: &[u8],
        expected_group: &[u8],
        expected_members: &[MemberPin],
    ) -> Result<Group> {
        bounded(expected_group, 512)?;
        let staged_provider = self.stage()?;
        let provider = &staged_provider.0;
        let welcome = match message(welcome)?.extract() {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => return Err(Error::InvalidProtocol),
        };
        let config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .padding_size(256)
            .max_past_epochs(0)
            .build();
        let staged = StagedWelcome::new_from_welcome(provider, &config, welcome, None)
            .map_err(|_| Error::InvalidProtocol)?;
        if staged.group_context().ciphersuite() != SUITE
            || staged.group_context().group_id().as_slice() != expected_group
        {
            return Err(Error::IdentityMismatch);
        }
        pins_match(
            staged
                .members()
                .map(|m| MemberPin {
                    identity: m.credential.serialized_content().to_vec(),
                    signature_key: m.signature_key,
                })
                .collect(),
            expected_members,
        )?;
        let group = staged
            .into_group(provider)
            .map(Group)
            .map_err(|_| Error::InvalidProtocol)?;
        self.promote(&staged_provider)?;
        Ok(group)
    }
    /// Pins must come from the authorized client; a server key package alone
    /// is not verified device authorization.
    pub fn add(
        &self,
        group: &mut Group,
        package: &[u8],
        identity: &[u8],
        signature_key: &[u8],
    ) -> Result<Addition> {
        self.own(group)?;
        bounded(package, 65536)?;
        bounded(identity, 512)?;
        bounded(signature_key, 32)?;
        let package = KeyPackageIn::tls_deserialize_exact(package)
            .map_err(|_| Error::InvalidProtocol)?
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|_| Error::InvalidProtocol)?;
        let leaf = package.leaf_node();
        if leaf.credential().serialized_content() != identity
            || leaf.signature_key().as_slice() != signature_key
        {
            return Err(Error::IdentityMismatch);
        }
        if group.0.members().count() >= 1000 {
            return Err(Error::InvalidInput);
        }
        if group.0.members().any(|m| {
            m.credential.serialized_content() == identity || m.signature_key == signature_key
        }) {
            return Err(Error::IdentityMismatch);
        }
        let (commit, welcome, _) = group
            .0
            .add_members(&self.provider, &self.signer, &[package])
            .map_err(|_| Error::InvalidProtocol)?;
        Ok(Addition {
            commit: wire(&commit)?,
            welcome: wire(&welcome)?,
        })
    }
    /// Publish the pending commit before explicitly merging it. Failed delivery
    /// must not silently advance the sender's epoch.
    pub fn merge_pending(&self, group: &mut Group) -> Result<()> {
        self.own(group)?;
        group
            .0
            .merge_pending_commit(&self.provider)
            .map_err(|_| Error::InvalidState)
    }
    pub fn remove(&self, group: &mut Group, identity: &[u8]) -> Result<Vec<u8>> {
        self.own(group)?;
        bounded(identity, 512)?;
        let member = group
            .0
            .members()
            .find(|m| m.credential.serialized_content() == identity)
            .ok_or(Error::IdentityMismatch)?;
        let (commit, _, _) = group
            .0
            .remove_members(&self.provider, &self.signer, &[member.index])
            .map_err(|_| Error::InvalidProtocol)?;
        wire(&commit)
    }
    pub fn encrypt(&self, group: &mut Group, bytes: &[u8]) -> Result<Vec<u8>> {
        self.own(group)?;
        bounded(bytes, MAX_PLAINTEXT)?;
        wire(
            &group
                .0
                .create_message(&self.provider, &self.signer, bytes)
                .map_err(|_| Error::InvalidState)?,
        )
    }
    pub fn receive(
        &self,
        group: &mut Group,
        bytes: &[u8],
        expected_members: &[MemberPin],
    ) -> Result<Received> {
        self.own(group)?;
        bounded(bytes, MAX_WIRE)?;
        // OpenMLS can advance an in-memory receive ratchet before a malformed
        // ciphertext is rejected. Stage all receive/storage changes privately;
        // publish them only after protocol AND pinned-roster validation succeed.
        let staged = self.stage()?;
        let staged_provider = &staged.0;
        let mut staged_group = Group(
            MlsGroup::load(staged_provider.storage(), group.0.group_id())
                .map_err(|_| Error::InvalidState)?
                .ok_or(Error::InvalidState)?,
        );
        let result =
            Self::receive_staged(staged_provider, &mut staged_group, bytes, expected_members);
        if result.is_ok() {
            self.promote(&staged)?;
            *group = staged_group;
        }
        result
    }
    fn receive_staged(
        provider: &OpenMlsRustCrypto,
        group: &mut Group,
        bytes: &[u8],
        expected_members: &[MemberPin],
    ) -> Result<Received> {
        let protocol = message(bytes)?
            .try_into_protocol_message()
            .map_err(|_| Error::InvalidProtocol)?;
        let received = group
            .0
            .process_message(provider, protocol)
            .map_err(|_| Error::InvalidProtocol)?;
        let sender = received.credential().serialized_content().to_vec();
        match received.into_content() {
            ProcessedMessageContent::ApplicationMessage(data) => {
                pins_match(
                    group
                        .0
                        .members()
                        .map(|m| MemberPin {
                            identity: m.credential.serialized_content().to_vec(),
                            signature_key: m.signature_key,
                        })
                        .collect(),
                    expected_members,
                )?;
                Ok(Received::Application {
                    sender,
                    bytes: data.into_bytes(),
                })
            }
            ProcessedMessageContent::StagedCommitMessage(commit) => {
                if let Some(tree) = commit
                    .export_ratchet_tree(provider.crypto(), group.0.export_ratchet_tree())
                    .map_err(|_| Error::InvalidProtocol)?
                {
                    pins_match(
                        tree.leaves()
                            .map(|leaf| MemberPin {
                                identity: leaf.credential().serialized_content().to_vec(),
                                signature_key: leaf.signature_key().as_slice().to_vec(),
                            })
                            .collect(),
                        expected_members,
                    )?;
                } else {
                    // An evicted endpoint cannot validate the new private state.
                    // It must not retain an active group or accept future payloads.
                    if !commit.self_removed() {
                        return Err(Error::InvalidProtocol);
                    }
                }
                group
                    .0
                    .merge_staged_commit(provider, *commit)
                    .map_err(|_| Error::InvalidProtocol)?;
                Ok(Received::Commit)
            }
            _ => Err(Error::InvalidProtocol),
        }
    }
}
impl Group {
    pub fn epoch(&self) -> u64 {
        self.0.epoch().as_u64()
    }
    pub fn active(&self) -> bool {
        self.0.is_active()
    }
}
