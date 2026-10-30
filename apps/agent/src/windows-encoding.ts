// Process-local encoding for PowerShell output and native pipeline input.
export const windowsUtf8Preamble = "$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ";
