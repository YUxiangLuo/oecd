"""Deterministic public credentials for the explicitly enabled classroom demo."""

from dataclasses import dataclass

DEMO_STUDENT_COUNT = 50
DEMO_STUDENT_USERNAMES = frozenset(
    "student" if index == 1 else f"student{index:02d}" for index in range(1, DEMO_STUDENT_COUNT + 1)
)


class DemoSeedPasswordProtected(ValueError):
    pass


@dataclass(frozen=True)
class DemoStudentCredential:
    username: str
    display_name: str
    student_no: str
    password: str


def demo_student_credentials(base_password: str) -> list[DemoStudentCredential]:
    """Return the 50 frontend-visible demo pairs.

    ``student`` keeps the historical base password so existing smoke scripts remain
    compatible.  The remaining accounts append their two-digit index, giving every
    student a distinct username and password without persisting another secret.
    """
    if not base_password:
        return []
    return [
        DemoStudentCredential(
            username="student" if index == 1 else f"student{index:02d}",
            display_name=f"演示学生 {index:02d}",
            student_no=f"2026{index:03d}",
            password=base_password if index == 1 else f"{base_password}-{index:02d}",
        )
        for index in range(1, DEMO_STUDENT_COUNT + 1)
    ]


def is_demo_student_username(username: str) -> bool:
    return username in DEMO_STUDENT_USERNAMES


# The demo teacher's password is the one the login page's 教师身份 chip pre-fills; changing it would lock
# everyone (the demo's owner included) out of the teacher side.
DEMO_TEACHER_USERNAME = "teacher"


def is_demo_account_username(username: str) -> bool:
    return username == DEMO_TEACHER_USERNAME or is_demo_student_username(username)
