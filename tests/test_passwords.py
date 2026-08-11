import pytest

from gvcsim.classroom import passwords


def test_password_hash_parameters_are_explicit_and_legacy_rows_remain_verifiable():
    salt = "ab" * 16
    legacy = passwords.hash_password(
        "classroom-private-password",
        salt,
        iterations=passwords.LEGACY_ITERATIONS,
    )

    assert passwords.verify_password(
        "classroom-private-password",
        salt,
        legacy,
        algorithm=passwords.PBKDF2_SHA256,
        iterations=passwords.LEGACY_ITERATIONS,
    )
    assert not passwords.verify_password(
        "wrong-private-password",
        salt,
        legacy,
        algorithm=passwords.PBKDF2_SHA256,
        iterations=passwords.LEGACY_ITERATIONS,
    )
    assert passwords.needs_rehash(passwords.PBKDF2_SHA256, passwords.LEGACY_ITERATIONS)


def test_current_password_hash_does_not_need_rehash():
    salt = "cd" * 16
    current = passwords.hash_password("classroom-private-password", salt)

    assert passwords.verify_password(
        "classroom-private-password",
        salt,
        current,
        algorithm=passwords.CURRENT_ALGORITHM,
        iterations=passwords.CURRENT_ITERATIONS,
    )
    assert not passwords.needs_rehash(passwords.CURRENT_ALGORITHM, passwords.CURRENT_ITERATIONS)


@pytest.mark.parametrize(
    ("algorithm", "iterations", "salt"),
    [
        ("unknown", passwords.CURRENT_ITERATIONS, "ab" * 16),
        (passwords.PBKDF2_SHA256, passwords.MIN_ITERATIONS - 1, "ab" * 16),
        (passwords.PBKDF2_SHA256, passwords.MAX_ITERATIONS + 1, "ab" * 16),
        (passwords.PBKDF2_SHA256, passwords.CURRENT_ITERATIONS, "00"),
        (passwords.PBKDF2_SHA256, passwords.CURRENT_ITERATIONS, "not-hex"),
    ],
)
def test_password_hash_rejects_unknown_or_unbounded_parameters(algorithm, iterations, salt):
    with pytest.raises(passwords.PasswordHashError):
        passwords.hash_password(
            "classroom-private-password",
            salt,
            algorithm=algorithm,
            iterations=iterations,
        )
