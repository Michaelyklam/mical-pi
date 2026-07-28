# VTB Documentation Sync Skill

## Trigger

This skill should be invoked automatically when changes are detected in VTB source files:
- Path pattern: `Verkada-Backend/engtools/vtb/pkg/tasks/*.go`
- Path pattern: `Verkada-Backend/vtoolbox/vtoolbox/commands_config.yaml`
- Path pattern: `camera-firmware/verkada/camera/vcamera/**/*.{c,cpp,h,hpp,py}`
- Path pattern: `camera-firmware/verkada/layers/meta-verkada/meta-camera/recipes-core/**/*`
- Path pattern: `camera-firmware/verkada/camera/go/camera/services/configurer/**/*.go`

## Purpose

Keep the VTB Support Documentation in sync with the VTB source code. When VTB commands are added, modified, or removed, this skill updates the corresponding documentation files.

## Repository

- **Local Path:** `/Users/michael.lam/Documents/Verkada Repos/VTB-Support-Docs/`
- **Remote:** `https://github.com/verkada/VTB-Support-documentation.git`

## File Mapping

### VTB CLI Commands (Go source)

| VTB Source File | Documentation File |
|-----------------|-------------------|
| `session.go` | `02-session.md` |
| `device.go` | `03-device.md` |
| `camera.go`, `camera_mgmt.go` | `04-camera.md` |
| `user.go` | `05-user.md` |
| `organizations.go` | `06-organization.md` |
| `feature_flags.go` | `07-feature-flags.md` |
| `access.go` | `08-access-control.md` |
| `gateway.go` | `09-gateway.md` |
| `alarms.go`, `sensors.go` | `10-alarms-sensors.md` |
| `configs.go`, `vdeviceconfig.go` | `11-configuration.md` |
| `vmdm.go`, `view_station.go` | `12-vmdm.md` |
| `connectbox.go` | `13-connectbox.md` |
| `break_the_glass.go` | `14-btg.md` |
| `sim.go` | `15-sim.md` |
| `workplace.go` | `16-workplace.md` |
| `data_access.go`, `security_data.go` | `17-data-access.md` |
| `events.go` | `18-events.md` |
| `elevator_association.go` | `19-elevator.md` |
| `commercial.go` | `20-commercial.md` |
| `remotesh.go`, `quota_management.go`, `bugbounty.go` | `21-remotesh.md` |

### RemoteSH Commands (YAML config)

Source: `Verkada-Backend/vtoolbox/vtoolbox/commands_config.yaml`

| YAML Section | Documentation File |
|---|---|
| `processes` | `22-remotesh-processes.md` |
| `storage` | `23-remotesh-storage.md` |
| `upgrade` | `24-remotesh-upgrade.md` |
| `service` | `25-remotesh-service.md` |
| `fs` | `26-remotesh-filesystem.md` |
| `network` | `27-remotesh-network.md` |
| `camera` | `28-remotesh-camera.md` |
| `access` | `29-remotesh-access.md` |
| `sensors` | `30-remotesh-sensors.md` |
| `system` | `31-remotesh-system.md` |
| `connectbox` | `32-remotesh-connectbox.md` |
| `alarms` | `33-remotesh-alarms.md` |
| `lte` | `34-remotesh-lte.md` |
| `util` | `35-remotesh-utilities.md` |
| `encoder` | `36-remotesh-encoder.md` |
| `auth_token` | `37-remotesh-auth.md` |
| `endpoint_accessible` | `38-remotesh-endpoint.md` |
| `gateway` | `39-remotesh-gateway.md` |
| `peertopeer` | `40-remotesh-peertopeer.md` |
| `verkada_linux` | `41-remotesh-verkada-linux.md` |
| `test` | `42-remotesh-test.md` |

### Camera Firmware System Files

Source: Multiple paths in `camera-firmware/` repository

| Firmware Source Area | Documentation File |
|---|---|
| `verkada/camera/vcamera/` (C/C++ — file path references in source) | `appendix-d-system-files.md`, `43-system-files-config.md`, `44-system-files-runtime.md`, `45-system-files-system.md` |
| `verkada/layers/meta-verkada/meta-camera/recipes-core/camera-base-files/` (mount scripts, partitions, boot) | `appendix-d-system-files.md`, `43-system-files-config.md`, `45-system-files-system.md` |
| `verkada/camera/go/camera/services/configurer/` (Go — configurer file operations) | `appendix-d-system-files.md`, `43-system-files-config.md`, `44-system-files-runtime.md` |
| `verkada/camera/go/camera/paths/` (Go — generated path constants) | `appendix-d-system-files.md`, `43-system-files-config.md`, `44-system-files-runtime.md`, `45-system-files-system.md` |

## Standard Operating Procedure

### Step 1: Identify Changed Files

```bash
# Check for changes in VTB task files
git -C "/Users/michael.lam/Documents/Verkada Repos/Verkada-Backend" diff --name-only HEAD~1 -- engtools/vtb/pkg/tasks/*.go

# Check for changes in RemoteSH config
git -C "/Users/michael.lam/Documents/Verkada Repos/Verkada-Backend" diff --name-only HEAD~1 -- vtoolbox/vtoolbox/commands_config.yaml

# Or check unstaged changes
git -C "/Users/michael.lam/Documents/Verkada Repos/Verkada-Backend" diff --name-only -- engtools/vtb/pkg/tasks/*.go vtoolbox/vtoolbox/commands_config.yaml

# Check for changes in camera firmware system files
git -C "/Users/michael.lam/Documents/Verkada Repos/camera-firmware" diff --name-only HEAD~1 -- verkada/camera/vcamera/ verkada/layers/meta-verkada/meta-camera/recipes-core/ verkada/camera/go/camera/services/configurer/ verkada/camera/go/camera/paths/
```

### Step 2: Analyze Changes

#### For VTB CLI source files (.go):

1. **Read the changed VTB source file** from the main worktree:
   ```
   /Users/michael.lam/Documents/Verkada Repos/Verkada-Backend/engtools/vtb/pkg/tasks/{file}.go
   ```

2. **Identify what changed**:
   - New commands added (look for new `&cobra.Command{}` definitions)
   - Modified commands (changed `Use`, `Short`, `Long`, `Flags`, or `Run` functions)
   - Removed commands

3. **Extract command details** for new/modified commands:
   - Command name (`Use` field)
   - Aliases (`Aliases` field)
   - Description (`Short` and `Long` fields)
   - Flags (from `Flags()` function)
   - Session requirements (from code that reads session fields)
   - Backend endpoint (from API calls)

#### For RemoteSH commands (commands_config.yaml):

1. **Read the YAML file** from the main worktree:
   ```
   /Users/michael.lam/Documents/Verkada Repos/Verkada-Backend/vtoolbox/vtoolbox/commands_config.yaml
   ```

2. **Identify what changed** in the `config:` section:
   - New commands added to a section
   - Modified commands (changed `command`, `help`, `args`, or `script`)
   - Removed commands
   - New sections added

3. **Extract command details** for each command:
   - **Command name**: The YAML key under the section (e.g., `df`, `reboot`)
   - **Help text**: The `help` field
   - **Underlying command**: The `command` field (inline shell) or `script.executable` (script file)
   - **Arguments**: From the `args` map, each with:
     - `help`: Argument description
     - `regex`: Validation regex pattern (optional)
     - `allowed_values`: List of allowed values (optional)
     - `allowed_paths`: List of allowed file paths (optional)
   - **Message code**: The `message_code` field (audit trail identifier, optional)

#### For Camera Firmware source files:

1. **Read changed firmware source files** from:
   - C/C++ sources: `/Users/michael.lam/Documents/Verkada Repos/camera-firmware/verkada/camera/vcamera/`
   - Yocto recipes: `/Users/michael.lam/Documents/Verkada Repos/camera-firmware/verkada/layers/meta-verkada/meta-camera/`
   - Go services: `/Users/michael.lam/Documents/Verkada Repos/camera-firmware/verkada/camera/go/camera/services/`
   - Path constants: `/Users/michael.lam/Documents/Verkada Repos/camera-firmware/verkada/camera/go/camera/paths/`

2. **Identify system file path changes** by searching the diff for string literals containing:
   - `/mnt/config/`, `/mnt/internal/`, `/mnt/sdcard`, `/mnt/sm_cache/`, `/mnt/approot/`
   - `/tmp/` (config copies, sockets, flags, heartbeats)
   - `/var/log/`, `/var/run/lock/` (logs and lock files)
   - `/etc/` (version files, firmware config, service limits)
   - `/sys/`, `/proc/` (hardware interfaces, kernel info)
   - `/dev/` (block devices, character devices)
   - `fopen(`, `open(`, `creat(` with literal path arguments

3. **Extract file details** for new/modified paths:
   - Full filesystem path on the device
   - What the file contains (data format, example values)
   - What service/process writes to it and what triggers the write
   - What service/process reads from it
   - Whether a VTB RemoteSH command exists to access it (check commands_config.yaml)
   - Which device types have this file

4. **Update `appendix-d-system-files.md`**:
   - Add new file entries to the appropriate filesystem path section
   - For data files: add to the table with Path, Contents, Written By, Read By, VTB Access, Devices columns
   - For flag files (zero-byte sentinels): add to the flag files table with Path, Effect When Present, Set Command, Remove Command, Devices columns
   - For socket files: add to the Unix Sockets (IPC) table with Path, Purpose, Created By, Used By, Devices columns
   - Update the Boot Sequence / Config Update / Firmware Upgrade timeline appendices if the sequence changed
   - Remove entries for deleted file paths

### Step 3: Update Documentation

#### For VTB CLI commands:

1. **Read the corresponding documentation file**:
   ```
   /Users/michael.lam/Documents/Verkada Repos/VTB-Support-Docs/{doc-file}.md
   ```

2. **For new commands**, add documentation following this template:
   ```markdown
   ---

   ### command-name

   Description of what the command does.

   **What it does:**
   1. Step one
   2. Step two

   **Backend Endpoint:** `/endpoint/path`

   **Session Requirements:** `field1`, `field2`

   **Flags:**
   | Flag | Type | Required | Default | Description |
   |------|------|----------|---------|-------------|
   | --flag | string | No | - | Description |

   **Example:**
   ```bash
   vtb> command-name --flag value
   ```

   **Successful Output:**
   ```json
   {
     "success": true,
     "message": "Operation completed"
   }
   ```

   **Common Failures:**

   *Error scenario:*
   ```
   Error: Error message
   ```
   ```

3. **For modified commands**, update the relevant sections while preserving existing examples and failure cases where still applicable.

4. **For removed commands**, remove the command section from documentation.

5. **Update the "Last Modified" date** at the bottom of the file:
   ```markdown
   ---

   *Last Modified: YYYY-MM-DD*

   [← Back to Index](./README.md)
   ```

#### For RemoteSH commands:

1. **Read the corresponding documentation file** based on the YAML section (see RemoteSH File Mapping above).

2. **For new commands**, add documentation following this template:

   ```markdown
   ---

   ### command-name

   [Help text from YAML]

   **Command Type:** RemoteSH (executed on device via remote shell)

   **Underlying Command:** `{shell command from YAML}`

   **Session Requirements:** `device-id` OR `serial-number`

   **Arguments:**
   | Argument | Type | Validation | Description |
   |----------|------|------------|-------------|
   | {arg_name} | string | regex: `{pattern}` / allowed: `[values]` | {help text} |

   **Example Usage:**
   ```
   vtb> command-name {arg_example}
   ```

   **Oneshot Mode:**
   ```bash
   vtb -c "sd DEVICE_UUID" && vtb -c "command-name {arg_example}"
   ```

   **Expected Output:**
   [Inferred from the command - e.g., stdout from the underlying shell command]

   **Common Failures:**

   *No session device set:*
   ```
   Error: Must have device-id or serial number
   ```

   *Device offline:*
   ```
   Error with status code 500: Command execution failed on device
   ```
   ```

3. **For modified commands**, update the relevant sections.

4. **For removed commands**, remove the command section from documentation.

5. **Each RemoteSH doc file** should have this structure:

   ```markdown
   # RemoteSH: {Section Title}

   These commands are executed directly on devices via secure remote shell. They require an active session with `device-id` or `serial-number`.

   **Device Types:** {cameras / access controllers / gateways / etc.}

   **How to run:** See [RemoteSH Overview](./21-remotesh.md) for session setup and execution details.

   ---

   ### command-1
   ...

   ---

   ### command-2
   ...

   ---

   *Last Modified: YYYY-MM-DD*

   [← Back to Index](./README.md)
   ```

### Step 4: Update Command Index

If commands were added or removed, update `appendix-a-command-index.md`:
- Add new commands in alphabetical order
- Remove deleted commands
- Update command counts in `README.md` if needed

### Step 5: Commit and Push

```bash
cd "/Users/michael.lam/Documents/Verkada Repos/VTB-Support-Docs"

# Stage the documentation changes
git add .

# Commit with descriptive message
git commit -m "$(cat <<'EOF'
docs(vtb): Update documentation for {changed-area}

- {Brief description of changes}
- Updated: {list of doc files}

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"

# Push to remote (https://github.com/verkada/VTB-Support-documentation)
git push origin main
```

## Documentation Standards

### Command Documentation Must Include:
- Clear description of what the command does
- Backend service and endpoint (for CLI commands) or underlying shell command (for RemoteSH)
- All session requirements
- All flags/arguments with types, defaults, and descriptions
- At least one usage example
- At least one successful output example
- Common failure scenarios with error messages

### Formatting Rules:
- Use `###` for command headers
- Use code blocks with appropriate language tags
- Use tables for flags/arguments
- Separate commands with `---` horizontal rules
- Keep descriptions concise but complete

## Example Workflow

### VTB CLI Command Change:
```
1. Detect: session.go changed
2. Read: /Users/michael.lam/Documents/Verkada Repos/Verkada-Backend/engtools/vtb/pkg/tasks/session.go
3. Analyze: New command "set-custom-field" added
4. Read: /Users/michael.lam/Documents/Verkada Repos/VTB-Support-Docs/02-session.md
5. Update: Add documentation for "set-custom-field"
6. Update: Add "Last Modified: YYYY-MM-DD" footer
7. Commit: "docs(vtb): Add set-custom-field command documentation"
8. Push: git push origin main (to verkada/VTB-Support-documentation)
```

### RemoteSH Command Change:
```
1. Detect: commands_config.yaml changed
2. Read: /Users/michael.lam/Documents/Verkada Repos/Verkada-Backend/vtoolbox/vtoolbox/commands_config.yaml
3. Analyze: New command "check-firmware" added to "upgrade" section
4. Read: /Users/michael.lam/Documents/Verkada Repos/VTB-Support-Docs/24-remotesh-upgrade.md
5. Update: Add documentation for "check-firmware" using RemoteSH template
6. Update: Add "Last Modified: YYYY-MM-DD" footer
7. Update: Add to appendix-a-command-index.md alphabetically
8. Commit: "docs(vtb): Add check-firmware RemoteSH command documentation"
9. Push: git push origin main (to verkada/VTB-Support-documentation)
```

### Camera Firmware File Path Change:
```
1. Detect: vcamera/subsystem/src/hardware/default_hardware.py changed
2. Read: the changed file, grep for file path string literals
3. Analyze: New file `/tmp/thermal_throttle_active` written by subsystem when thermal threshold exceeded
4. Read: /Users/michael.lam/Documents/Verkada Repos/VTB-Support-Docs/appendix-d-system-files.md
5. Update: Add entry to §3 (/tmp/) section — path, contents, writer (subsystem), reader, trigger (thermal threshold)
6. Update: Add "Last Modified: YYYY-MM-DD" footer
7. Commit: "docs(vtb): Add thermal_throttle_active to system files reference"
8. Push: git push origin main (to verkada/VTB-Support-documentation)
```

## Notes

- Always read from the main worktree path for VTB source files (gitlink resolution)
- Preserve existing documentation structure and formatting
- When unsure about command behavior, check the `Run` function implementation
- Cross-reference with backend API code if endpoint behavior is unclear
- For RemoteSH commands, the `command` field shows the exact shell command executed on device
- Commands with `script` instead of `command` execute a shell script uploaded to the device
- The `message_code` field indicates audit trail entries (e.g., `RDA_PROCESS_KILL`, `RDA_SD_REFORMAT`)
- Arguments with `regex` validation restrict input to matching patterns
- Arguments with `allowed_values` restrict input to a predefined list
- Arguments with `allowed_paths` restrict file path arguments to approved locations
- For firmware file path changes, search the diff for string literals containing `/mnt/`, `/tmp/`, `/var/`, `/etc/`, `/sys/`, `/proc/`, `/dev/`
- Camera firmware system file paths are documented in `appendix-d-system-files.md`, organized by filesystem path category
- Flag files (zero-byte sentinels) and data files have different table schemas in the appendix — check the section structure before adding
- Socket files in `/tmp/` should be documented even though they cannot be `cat`'d — their presence/absence indicates service status
- When a new service or daemon is added to the firmware, check for ALL file paths it references (config, tmp, logs, sockets, locks)
- The camera firmware repo is at `/Users/michael.lam/Documents/Verkada Repos/camera-firmware/`
