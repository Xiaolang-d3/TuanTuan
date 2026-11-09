"""Check real Windows ACLs, rather than interpreting POSIX chmod bits."""
import json
import os
import subprocess

import pytest

from app.db import init_db
from app.library.sources import get_source_file, import_file_source


@pytest.mark.skipif(os.name != "nt", reason="Windows ACL audit; POSIX permissions are tested separately")
def test_account_owned_file_acl_does_not_grant_broad_access(tmp_path, record_property):
    path = tmp_path / "workspace.db"
    init_db(path)
    source = import_file_source(filename="private.txt", content_bytes=b"private fixture", db_path=path)
    original, _, _ = get_source_file(source["id"], path)
    # The child process only reads this test's temporary file security descriptor.
    script = """
$ErrorActionPreference = 'Stop'
$acl = [System.IO.File]::GetAccessControl($env:TUANTUAN_ACL_TEST_FILE)
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  @{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;
    rights=[int]$_.FileSystemRights; type=$_.AccessControlType.ToString(); inherited=$_.IsInherited}
})
@{owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
  current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules=$rules} | ConvertTo-Json -Depth 4 -Compress
"""
    environment = {**os.environ, "TUANTUAN_ACL_TEST_FILE": str(original)}
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                            env=environment, capture_output=True, check=False, timeout=15)
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")
    acl = json.loads(result.stdout.decode("utf-8-sig"))
    record_property("workspace_acl", json.dumps(acl))
    assert acl["owner"] in {acl["current"], "S-1-5-32-544"}
    broad_principals = {"S-1-1-0", "S-1-5-11", "S-1-5-32-545"}
    # ReadData, WriteData and AppendData: no general-purpose user principal.
    assert not any(rule["sid"] in broad_principals and rule["type"] == "Allow" and rule["rights"] & 7
                   for rule in acl["rules"])
    assert original.read_bytes() == b"private fixture"
