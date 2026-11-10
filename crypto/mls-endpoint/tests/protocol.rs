use quill_mls_endpoint::{Endpoint, Error, Group, MemberPin, Received};
fn pin(endpoint: &Endpoint, id: &[u8]) -> MemberPin {
    MemberPin {
        identity: id.to_vec(),
        signature_key: endpoint.signature_key(),
    }
}
fn received(value: Received, identity: &[u8], plaintext: &[u8]) {
    match value {
        Received::Application { sender, bytes } => {
            assert_eq!(sender, identity);
            assert_eq!(bytes, plaintext);
        }
        _ => panic!("Expected application message"),
    }
}
fn pair() -> (Endpoint, Group, Endpoint, Group, Vec<MemberPin>) {
    let a = Endpoint::new(b"alice-device").unwrap();
    let b = Endpoint::new(b"bob-device").unwrap();
    let mut ag = a.create_group(b"workspace:document").unwrap();
    let roster = vec![pin(&a, b"alice-device"), pin(&b, b"bob-device")];
    let add = a
        .add(
            &mut ag,
            &b.key_package().unwrap(),
            b"bob-device",
            &b.signature_key(),
        )
        .unwrap();
    assert_eq!(ag.epoch(), 0);
    a.merge_pending(&mut ag).unwrap();
    let bg = b
        .join(&add.welcome, b"workspace:document", &roster)
        .unwrap();
    assert_eq!(ag.epoch(), bg.epoch());
    (a, ag, b, bg, roster)
}
#[test]
fn signed_encrypted_roundtrip_replay_tamper_and_cross_group_rejection() {
    let (a, mut ag, b, mut bg, roster) = pair();
    let text = b"Confidential legal working text";
    let encrypted = a.encrypt(&mut ag, text).unwrap();
    assert!(!encrypted.windows(text.len()).any(|w| w == text));
    let mut altered = encrypted.clone();
    let last = altered.len() - 1;
    altered[last] ^= 1;
    assert!(b.receive(&mut bg, &altered, &roster).is_err());
    received(
        b.receive(&mut bg, &encrypted, &roster).unwrap(),
        b"alice-device",
        text,
    );
    assert!(b.receive(&mut bg, &encrypted, &roster).is_err());
    let back = b.encrypt(&mut bg, b"Reviewed on Bob's endpoint").unwrap();
    received(
        a.receive(&mut ag, &back, &roster).unwrap(),
        b"bob-device",
        b"Reviewed on Bob's endpoint",
    );
    let (_, _, other, mut unrelated, other_roster) = pair();
    assert!(other
        .receive(&mut unrelated, &encrypted, &other_roster)
        .is_err());
}
#[test]
fn removal_rotates_epoch_and_denies_excluded_member_future_content() {
    let (a, mut ag, b, mut bg, mut roster) = pair();
    let c = Endpoint::new(b"carol-device").unwrap();
    roster.push(pin(&c, b"carol-device"));
    let addition = a
        .add(
            &mut ag,
            &c.key_package().unwrap(),
            b"carol-device",
            &c.signature_key(),
        )
        .unwrap();
    a.merge_pending(&mut ag).unwrap();
    assert!(matches!(
        b.receive(&mut bg, &addition.commit, &roster).unwrap(),
        Received::Commit
    ));
    let mut cg = c
        .join(&addition.welcome, b"workspace:document", &roster)
        .unwrap();
    let before = a.encrypt(&mut ag, b"Old epoch").unwrap();
    received(
        b.receive(&mut bg, &before, &roster).unwrap(),
        b"alice-device",
        b"Old epoch",
    );
    let removal = a.remove(&mut ag, b"bob-device").unwrap();
    a.merge_pending(&mut ag).unwrap();
    roster.retain(|p| p.identity != b"bob-device");
    assert!(matches!(
        c.receive(&mut cg, &removal, &roster).unwrap(),
        Received::Commit
    ));
    assert!(matches!(
        b.receive(&mut bg, &removal, &roster).unwrap(),
        Received::Commit
    ));
    assert!(!bg.active());
    let after = a.encrypt(&mut ag, b"After member removal").unwrap();
    received(
        c.receive(&mut cg, &after, &roster).unwrap(),
        b"alice-device",
        b"After member removal",
    );
    assert!(b.receive(&mut bg, &after, &roster).is_err());
    assert!(b.encrypt(&mut bg, b"Excluded sender").is_err());
    assert!(c.receive(&mut cg, &before, &roster).is_err());
}
#[test]
fn substitute_identity_or_key_cannot_be_admitted() {
    let (a, mut ag, b, _bg, roster) = pair();
    let impostor = Endpoint::new(b"carol-device").unwrap();
    let package = impostor.key_package().unwrap();
    assert!(matches!(
        a.add(&mut ag, &package, b"bob-device", &b.signature_key()),
        Err(Error::IdentityMismatch)
    ));
    assert!(matches!(
        a.add(&mut ag, &package, b"carol-device", &b.signature_key()),
        Err(Error::IdentityMismatch)
    ));
    assert_eq!(ag.epoch(), 1);
    // An authenticated commit is still not client authorization for a changed roster.
    let c = Endpoint::new(b"carol-device").unwrap();
    let addition = a
        .add(
            &mut ag,
            &c.key_package().unwrap(),
            b"carol-device",
            &c.signature_key(),
        )
        .unwrap();
    a.merge_pending(&mut ag).unwrap();
    assert!(c
        .join(&addition.welcome, b"workspace:document", &roster)
        .is_err());
}
#[test]
fn bad_group_scope_or_unapproved_roster_is_rejected() {
    for wrong_scope in [false, true] {
        let (a, mut ag, b, mut bg, roster) = pair();
        let c = Endpoint::new(b"carol-device").unwrap();
        let mut expanded = roster.clone();
        expanded.push(pin(&c, b"carol-device"));
        let add = a
            .add(
                &mut ag,
                &c.key_package().unwrap(),
                b"carol-device",
                &c.signature_key(),
            )
            .unwrap();
        if wrong_scope {
            assert!(c.join(&add.welcome, b"other-workspace", &expanded).is_err());
        } else {
            assert!(b.receive(&mut bg, &add.commit, &roster).is_err());
            assert_eq!(bg.epoch(), 1);
        }
    }
}
#[test]
fn malformed_inputs_are_bounded_and_generic() {
    let (a, mut ag, b, mut bg, roster) = pair();
    for bytes in [&[][..], &[0][..], &[255; 128][..]] {
        assert!(b.receive(&mut bg, bytes, &roster).is_err());
    }
    assert!(a.encrypt(&mut ag, &[]).is_err());
    assert!(a.encrypt(&mut ag, &vec![0; 1_000_001]).is_err());
    assert!(b.receive(&mut bg, &vec![0; 2_000_001], &roster).is_err());
    assert!(Endpoint::new(&[]).is_err());
    assert!(a.create_group(&vec![0; 513]).is_err());
    let mut package = b.key_package().unwrap();
    package.push(0);
    assert!(a
        .add(&mut ag, &package, b"bob-device", &b.signature_key())
        .is_err());
}
#[test]
fn failed_scope_and_roster_checks_do_not_consume_an_authentic_welcome() {
    let a = Endpoint::new(b"alice-device").unwrap();
    let b = Endpoint::new(b"bob-device").unwrap();
    let mut ag = a.create_group(b"authorized-scope").unwrap();
    let pins = vec![pin(&a, b"alice-device"), pin(&b, b"bob-device")];
    let addition = a
        .add(
            &mut ag,
            &b.key_package().unwrap(),
            b"bob-device",
            &b.signature_key(),
        )
        .unwrap();
    a.merge_pending(&mut ag).unwrap();
    assert!(b.join(&addition.welcome, b"wrong-scope", &pins).is_err());
    assert!(b
        .join(&addition.welcome, b"authorized-scope", &pins[..1])
        .is_err());
    let bg = b
        .join(&addition.welcome, b"authorized-scope", &pins)
        .unwrap();
    assert_eq!(ag.epoch(), bg.epoch());
    assert!(b
        .join(&addition.welcome, b"authorized-scope", &pins)
        .is_err());
}
#[test]
fn malformed_protocol_corpus_never_panics_or_advances_epoch() {
    let (_a, _ag, b, mut bg, pins) = pair();
    let mut seed = 0xdec1de_u32;
    for length in 0..2048 {
        let mut bytes = vec![0; length];
        for value in &mut bytes {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            *value = (seed >> 24) as u8;
        }
        assert!(b.receive(&mut bg, &bytes, &pins).is_err());
        assert_eq!(bg.epoch(), 1);
    }
}
#[test]
fn native_groups_cannot_switch_endpoint_ownership_or_overwrite_an_existing_scope() {
    let (a, mut ag, b, _bg, _pins) = pair();
    assert!(a.create_group(b"workspace:document").is_err());
    assert!(b.encrypt(&mut ag, b"Wrong endpoint").is_err());
    assert!(b.remove(&mut ag, b"alice-device").is_err());
}
