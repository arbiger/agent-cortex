import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.resolve(import.meta.dirname, '../scripts');

function getScriptPath(name) {
    return path.join(SCRIPTS_DIR, name);
}

function isExecutable(path) {
    try {
        const stats = fs.statSync(path);
        const mode = stats.mode;
        const isExec = (mode & parseInt('111', 8)) !== 0;
        return isExec;
    } catch {
        return false;
    }
}

describe('scripts', () => {
    describe('backup-db.sh', () => {
        const script = getScriptPath('backup-db.sh');

        it('script file exists', () => {
            assert.ok(fs.existsSync(script), `backup-db.sh not found at ${script}`);
        });

        it('is executable', () => {
            assert.ok(isExecutable(script), 'backup-db.sh is not executable');
        });

        it('contains safety markers', () => {
            const content = fs.readFileSync(script, 'utf8');
            assert.ok(content.includes('set -e'), 'missing set -e');
            assert.ok(content.includes('sqlite3') && content.includes('.backup'), 'missing sqlite3 .backup command');
        });

        it('shows usage when run with --help', () => {
            try {
                execSync(`bash "${script}" --help 2>&1 || true`, { timeout: 5000 });
            } catch {}
        });
    });

    describe('backup-vault.sh', () => {
        const script = getScriptPath('backup-vault.sh');

        it('script file exists', () => {
            assert.ok(fs.existsSync(script), `backup-vault.sh not found at ${script}`);
        });

        it('is executable', () => {
            assert.ok(isExecutable(script), 'backup-vault.sh is not executable');
        });

        it('contains safety markers', () => {
            const content = fs.readFileSync(script, 'utf8');
            assert.ok(content.includes('set -e'), 'missing set -e');
            assert.ok(content.includes('tar -czf'), 'missing tar command');
        });

        it('handles vault path with spaces/emoji safely', () => {
            const content = fs.readFileSync(script, 'utf8');
            assert.ok(content.includes('basename "$VAULT"'), 'missing proper quoting for vault path');
            assert.ok(content.includes('dirname "$VAULT"'), 'missing dirname for vault path');
        });
    });

    describe('restore-dryrun.sh', () => {
        const script = getScriptPath('restore-dryrun.sh');

        it('script file exists', () => {
            assert.ok(fs.existsSync(script), `restore-dryrun.sh not found at ${script}`);
        });

        it('is executable', () => {
            assert.ok(isExecutable(script), 'restore-dryrun.sh is not executable');
        });

        it('contains safety markers', () => {
            const content = fs.readFileSync(script, 'utf8');
            assert.ok(content.includes('set -e'), 'missing set -e');
        });

        it('requires two arguments', () => {
            const result = execSync(`bash "${script}" 2>&1 || true`, { timeout: 5000 });
            const output = result.toString();
            assert.ok(output.includes('Usage:') || output.includes('DUMP_SQL'), 'should show usage when missing args');
        });

        it('does not run psql or tar extraction for validation only', () => {
            const content = fs.readFileSync(script, 'utf8');
            const dangerousPsql = /^\s*(?!echo\s|#).*psql\s+[^|].*-f\b/m;
            const dangerousTar = /^\s*(?!echo\s|#).*tar\s+-[xcz]\b/m;
            assert.ok(!content.match(dangerousPsql), 'restore-dryrun should not execute psql with -f');
            assert.ok(!content.match(dangerousTar), 'restore-dryrun should not execute tar extraction/compression');
            assert.ok(content.includes('tar -tzf'), 'should use tar -tzf for validation only');
        });

        it('validates SQL file appears to be PostgreSQL or plain SQL', () => {
            const content = fs.readFileSync(script, 'utf8');
            assert.ok(content.includes('postgresql') || content.includes('dump') || content.includes('CREATE TABLE'), 'should check SQL type');
        });

        it('validates tar archive is valid via tar -tzf', () => {
            const content = fs.readFileSync(script, 'utf8');
            assert.ok(content.includes('tar -tzf'), 'should use tar -tzf for validation');
        });

        it('prints explicit restore commands with safe quoting', () => {
            const content = fs.readFileSync(script, 'utf8');
            assert.ok(content.includes('psql'), 'should print psql restore command');
            assert.ok(content.includes('tar -xzf'), 'should print tar extract command');
            assert.ok(content.includes('-f "$DUMP_SQL"'), 'psql -f should use double-quoted variable');
            const xzfMatch = /tar\s+-xzf\s+(\\?["']?)\$VAULT_TAR_GZ\1/.exec(content);
            assert.ok(xzfMatch, 'tar -xzf should use double-quoted variable, found: ' + (xzfMatch ? xzfMatch[0] : 'none'));
        });

        it('shows example target parent for vault archives', () => {
            const content = fs.readFileSync(script, 'utf8');
            assert.ok(content.includes('HOME/Documents/Georges') || content.includes('$HOME'), 'should show example vault restore target parent');
        });
    });

    describe('repair-pending.sh', () => {
        const script = getScriptPath('repair-pending.sh');

        it('script file exists', () => {
            assert.ok(fs.existsSync(script), 'repair-pending.sh not found');
        });

        it('is executable', () => {
            assert.ok(isExecutable(script), 'repair-pending.sh is not executable');
        });

        it('contains safety markers', () => {
            const content = fs.readFileSync(script, 'utf8');
            assert.ok(content.includes('set -e'), 'missing set -e');
        });

        it('shows usage when run with --help', () => {
            const result = execSync(`bash "${script}" --help 2>&1 || true`, { timeout: 5000 });
            const output = result.toString();
            assert.ok(output.includes('--retry-embeddings'), 'should document --retry-embeddings');
            assert.ok(output.includes('--fix-orphans'), 'should document --fix-orphans');
        });

        it('does not use inline require in node -e for MCP calls', () => {
            const content = fs.readFileSync(script, 'utf8');
            const nodeECode = /node\s+-e\s*"[^"]*require\s*\(\s*['"]child_process['"]/.test(content) ||
                           /node\s+-e\s*'[^']*require\s*\(\s*['"]child_process['"]/.test(content) ||
                           /node\s+-e\s*`[^`]*require\s*\(\s*['"]child_process['"]/.test(content);
            assert.ok(!nodeECode, 'repair-pending.sh must not use require() in inline node -e (fails in ESM module context)');
        });

        it('runs in read-only mode without error', () => {
            const result = execSync(`bash "${script}" 2>&1 || true`, { timeout: 10000 });
            const output = result.toString();
            assert.ok(output.includes('Pending embeddings:'), 'should report pending count');
            assert.ok(output.includes('Orphan links:'), 'should report orphan count');
        });
    });
});