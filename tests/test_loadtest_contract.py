import pytest

from scripts import load_test_100_students as loadtest
from scripts import provision_load_test as provision


def test_capacity_tools_default_to_supported_classroom_size():
    load_args = loadtest._parser().parse_args(["--base-url", "http://127.0.0.1:18000", "--users-file", "users.json"])
    provision_args = provision._parser().parse_args([])

    assert load_args.students == provision_args.students == 50
    assert loadtest.CREDENTIAL_KIND == provision.CREDENTIAL_KIND == "gvcsim-capacity-test-users-v1"


@pytest.mark.parametrize("students", [20, 50])
def test_capacity_tools_accept_supported_boundaries(students):
    assert loadtest._validate_student_count(students) == students
    assert provision._validate_student_count(students) == students


@pytest.mark.parametrize("students", [0, 19, 51, 100])
def test_capacity_tools_reject_counts_outside_supported_scope(students):
    with pytest.raises(SystemExit, match="20..50"):
        loadtest._validate_student_count(students)
    with pytest.raises(SystemExit, match="20..50"):
        provision._validate_student_count(students)


def test_capacity_read_routes_match_current_api_contract():
    operations = dict(loadtest.READ_PATHS)

    assert operations["classroom_session"] == "/api/classroom/session"
    assert "/api/classroom/context" not in operations.values()
    assert len(operations) == len(loadtest.READ_PATHS)


def test_capacity_client_stays_below_deployed_request_limit():
    assert loadtest.MAX_STUDENTS <= loadtest.HTTP_CONNECTION_LIMIT < 64
