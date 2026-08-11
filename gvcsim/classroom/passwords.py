"""Versioned password hashing primitives for classroom accounts.

Legacy classroom databases used PBKDF2-HMAC-SHA256 with an implicit 100,000
iteration cost.  The current format stores algorithm and work factor beside the
salt/hash so a successful login can upgrade old rows without invalidating any
account or requiring a plaintext-password migration.
"""

from __future__ import annotations

import hashlib
import hmac

PBKDF2_SHA256 = "pbkdf2_sha256"
CURRENT_ALGORITHM = PBKDF2_SHA256
CURRENT_ITERATIONS = 600_000
LEGACY_ITERATIONS = 100_000
MIN_ITERATIONS = LEGACY_ITERATIONS
MAX_ITERATIONS = 10_000_000


class PasswordHashError(RuntimeError):
    """Stored password parameters are malformed or unsupported."""


def _validate_parameters(algorithm: str, iterations: int) -> None:
    if algorithm != PBKDF2_SHA256:
        raise PasswordHashError(f"不支持的口令哈希算法:{algorithm!r}")
    if isinstance(iterations, bool) or not isinstance(iterations, int):
        raise PasswordHashError("口令哈希迭代次数必须是整数")
    if not MIN_ITERATIONS <= iterations <= MAX_ITERATIONS:
        raise PasswordHashError(f"口令哈希迭代次数必须在 {MIN_ITERATIONS}..{MAX_ITERATIONS} 之间")


def hash_password(
    password: str,
    salt_hex: str,
    *,
    algorithm: str = CURRENT_ALGORITHM,
    iterations: int = CURRENT_ITERATIONS,
) -> str:
    """Hash one password using explicit, bounded parameters."""
    _validate_parameters(algorithm, iterations)
    try:
        salt = bytes.fromhex(salt_hex)
    except ValueError as error:
        raise PasswordHashError("口令盐不是合法十六进制") from error
    if len(salt) < 16:
        raise PasswordHashError("口令盐至少需要 16 字节")
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations).hex()


def verify_password(
    password: str,
    salt_hex: str,
    expected_hash: str,
    *,
    algorithm: str,
    iterations: int,
) -> bool:
    """Verify without normalizing unknown database parameters to a weaker default."""
    supplied = hash_password(
        password,
        salt_hex,
        algorithm=algorithm,
        iterations=iterations,
    )
    return hmac.compare_digest(expected_hash, supplied)


def needs_rehash(algorithm: str, iterations: int) -> bool:
    """Return whether a valid legacy row should be upgraded after authentication."""
    _validate_parameters(algorithm, iterations)
    return algorithm != CURRENT_ALGORITHM or iterations < CURRENT_ITERATIONS
