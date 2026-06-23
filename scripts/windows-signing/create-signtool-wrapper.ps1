<#
.SYNOPSIS
    Creates a selective signtool wrapper that skips signing for bundled tools.

.DESCRIPTION
    This script generates and compiles a C# executable that acts as a signtool wrapper.
    The wrapper intercepts signtool calls and:
    - Skips signing for files in exclusion paths (bundled Git, Node, etc.)
    - Passes through to real signtool for all other files
    
    This reduces Windows signing time from ~23 minutes to ~1-2 minutes by avoiding
    signing of ~350 bundled executables that already have their own signatures.

.PARAMETER RealSigntoolPath
    Path to the real signtool.exe that will be called for non-excluded files.

.PARAMETER OutputPath
    Path where the compiled wrapper executable will be written.

.PARAMETER LogFile
    Optional path to a log file for recording signing decisions.

.EXAMPLE
    .\create-signtool-wrapper.ps1 -RealSigntoolPath "$env:RUNNER_TEMP\real-signtool.exe" -OutputPath "node_modules\electron-winstaller\vendor\signtool.exe"

.NOTES
    Requires .NET Framework csc.exe compiler (available on Windows CI runners).
    The wrapper uses environment variable REAL_SIGNTOOL_PATH if RealSigntoolPath is not baked in.
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$RealSigntoolPath,
    
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    
    [Parameter(Mandatory = $false)]
    [string]$LogFile = ""
)

$ErrorActionPreference = "Stop"

Write-Host "=== Creating Selective Signtool Wrapper ===" -ForegroundColor Cyan
Write-Host "Real signtool: $RealSigntoolPath" -ForegroundColor Gray
Write-Host "Output path: $OutputPath" -ForegroundColor Gray
if ($LogFile) {
    Write-Host "Log file: $LogFile" -ForegroundColor Gray
}

# Verify real signtool exists
if (-not (Test-Path $RealSigntoolPath)) {
    Write-Host "ERROR: Real signtool not found at: $RealSigntoolPath" -ForegroundColor Red
    exit 1
}

# C# source code for the wrapper
$csharpSource = @"
using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;

namespace SigntoolWrapper
{
    class Program
    {
        // Path to real signtool - can be overridden by REAL_SIGNTOOL_PATH env var
        private const string DefaultRealSigntool = @"$RealSigntoolPath";
        
        // Log file path - can be overridden by SIGNTOOL_WRAPPER_LOG env var
        private const string DefaultLogFile = @"$LogFile";
        
        // Exclusion patterns - files matching these will NOT be signed
        private static readonly string[] ExclusionPatterns = new string[]
        {
            @"\\resources\\git-bundle\\",
            @"\\resources\\node-bundle\\",
            // Exclude Microsoft VC++ runtime DLLs (app-local) - preserve Microsoft signatures
            @"\\(concrt140|msvcp140.*|vcruntime140.*)\.dll$",
            // Exclude non-Windows native prebuilds that may be present in node_modules
            // (Squirrel enumerates them and attempts to sign, but signtool can't sign e.g. android-arm binaries)
            @"\\prebuilds\\(?!win32-)",
            @"\\dummy\.node$"  // Zero-byte placeholder file from @recallai/desktop-sdk - can't be signed
        };
        
        // Must-sign patterns - these files are NEVER excluded (safety check)
        // IMPORTANT: MustSignPatterns takes PRECEDENCE over ExclusionPatterns!
        // If a file matches both, it WILL be signed (see ShouldExclude logic below).
        private static readonly string[] MustSignPatterns = new string[]
        {
            @"Mindstone Rebel Beta\.exe$",
            @"Mindstone Rebel\.exe$",
            @"_ExecutionStub\.exe$",
            @"\\squirrel\.exe$",
            @"\\Update\.exe$",
        };
        
        static int Main(string[] args)
        {
            string logFile = Environment.GetEnvironmentVariable("SIGNTOOL_WRAPPER_LOG") ?? DefaultLogFile;
            string realSigntool = Environment.GetEnvironmentVariable("REAL_SIGNTOOL_PATH") ?? DefaultRealSigntool;
            
            // Log raw args for debugging
            Log(logFile, "DEBUG", string.Join("|", args), "Raw args received");
            
            // Find the file being signed (last argument that's a path to an existing file)
            // Also returns reconstructed args if path was split by spaces
            string[] fixedArgs;
            string fileToSign = FindFileArgument(args, out fixedArgs);
            
            // Log whether fixedArgs was populated
            if (fixedArgs != null)
            {
                Log(logFile, "DEBUG", string.Join("|", fixedArgs), "Fixed args (path reconstructed)");
            }
            else
            {
                Log(logFile, "DEBUG", "null", "fixedArgs is null (using original args)");
            }
            
            if (!string.IsNullOrEmpty(fileToSign))
            {
                // Check if file should be excluded
                if (ShouldExclude(fileToSign))
                {
                    Log(logFile, "SKIP", fileToSign, "Matched exclusion pattern");
                    Console.WriteLine("[signtool-wrapper] SKIP: " + fileToSign);
                    return 0; // Success without signing
                }
                
                // Wait for file to exist (handles race condition with Squirrel creating files)
                // Known issue: Squirrel may call signtool before file is fully written
                int maxWaitMs = 10000; // 10 seconds max wait
                int waitedMs = 0;
                int sleepMs = 250;
                while (!File.Exists(fileToSign) && waitedMs < maxWaitMs)
                {
                    Log(logFile, "WAIT", fileToSign, string.Format("File not yet present, waiting ({0}ms)", waitedMs));
                    Console.WriteLine("[signtool-wrapper] WAIT: File not yet present, waiting... " + fileToSign);
                    System.Threading.Thread.Sleep(sleepMs);
                    waitedMs += sleepMs;
                }
                
                if (!File.Exists(fileToSign))
                {
                    // File still doesn't exist after waiting - log diagnostic info and fail
                    string parentDir = Path.GetDirectoryName(fileToSign);
                    bool parentExists = Directory.Exists(parentDir);
                    Log(logFile, "ERROR", fileToSign, string.Format("File does not exist after {0}ms wait. Parent dir exists: {1}", maxWaitMs, parentExists));
                    Console.Error.WriteLine("[signtool-wrapper] ERROR: File not found after waiting: " + fileToSign);
                    
                    // List files in parent directory for diagnostics
                    if (parentExists)
                    {
                        try
                        {
                            string[] files = Directory.GetFiles(parentDir);
                            Log(logFile, "DIAG", string.Join("; ", files), "Files in parent directory");
                        }
                        catch { }
                    }
                    
                    return 2; // Distinct exit code for "file not found"
                }
                
                // File exists - also check if we can open it (not locked)
                try
                {
                    using (FileStream fs = File.Open(fileToSign, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    {
                        // File is accessible
                    }
                }
                catch (IOException ioEx)
                {
                    // File is locked - wait and retry
                    Log(logFile, "WAIT", fileToSign, "File is locked, waiting for release: " + ioEx.Message);
                    Console.WriteLine("[signtool-wrapper] WAIT: File is locked, waiting... " + fileToSign);
                    
                    int lockWaitMs = 0;
                    int maxLockWaitMs = 5000;
                    while (lockWaitMs < maxLockWaitMs)
                    {
                        System.Threading.Thread.Sleep(sleepMs);
                        lockWaitMs += sleepMs;
                        try
                        {
                            using (FileStream fs = File.Open(fileToSign, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                            {
                                Log(logFile, "DEBUG", fileToSign, string.Format("File unlocked after {0}ms", lockWaitMs));
                                break; // File is now accessible
                            }
                        }
                        catch (IOException)
                        {
                            // Still locked, continue waiting
                        }
                    }
                }
                
                // Validate PE header before signing - handles race condition where file exists
                // but hasn't been fully written yet (0x800700C1 ERROR_BAD_EXE_FORMAT)
                string peValidationError;
                int peWaitMs = 0;
                int maxPeWaitMs = 5000; // 5 seconds max for PE to become valid
                while (!ValidatePEHeader(fileToSign, out peValidationError))
                {
                    if (peWaitMs >= maxPeWaitMs)
                    {
                        // PE header still invalid after waiting - log diagnostics and let signtool fail naturally
                        // (it will give a better error message than us)
                        long fileSize = 0;
                        byte[] firstBytes = new byte[0];
                        try
                        {
                            FileInfo fi = new FileInfo(fileToSign);
                            fileSize = fi.Length;
                            using (FileStream fs = File.OpenRead(fileToSign))
                            {
                                firstBytes = new byte[Math.Min(64, (int)fs.Length)];
                                fs.Read(firstBytes, 0, firstBytes.Length);
                            }
                        }
                        catch { }
                        
                        string hexBytes = BitConverter.ToString(firstBytes).Replace("-", " ");
                        Log(logFile, "ERROR", fileToSign, string.Format(
                            "PE validation failed after {0}ms. Size: {1} bytes. First bytes: {2}. Error: {3}",
                            maxPeWaitMs, fileSize, hexBytes, peValidationError));
                        Console.Error.WriteLine("[signtool-wrapper] PE INVALID: " + fileToSign + " - " + peValidationError);
                        break; // Let signtool try anyway - it may have a more specific error
                    }
                    
                    Log(logFile, "WAIT", fileToSign, string.Format("PE invalid ({0}), waiting ({1}ms)", peValidationError, peWaitMs));
                    System.Threading.Thread.Sleep(sleepMs);
                    peWaitMs += sleepMs;
                }
                
                if (peWaitMs > 0 && peWaitMs < maxPeWaitMs)
                {
                    Log(logFile, "DEBUG", fileToSign, string.Format("PE became valid after {0}ms", peWaitMs));
                }
                
                // Log file details right before signing (to detect last-moment changes)
                try
                {
                    FileInfo fi = new FileInfo(fileToSign);
                    Log(logFile, "DEBUG", fileToSign, string.Format(
                        "File ready for signing. Size: {0} bytes, LastWrite: {1}",
                        fi.Length, fi.LastWriteTimeUtc.ToString("HH:mm:ss.fff")));
                }
                catch { }
                
                Log(logFile, "SIGN", fileToSign, "Passed to real signtool");
                Console.WriteLine("[signtool-wrapper] SIGN: " + fileToSign);
            }
            else
            {
                Log(logFile, "DEBUG", "null", "fileToSign is null");
            }
            
            // Pass through to real signtool (use fixed args if path was reconstructed)
            string[] argsToUse = fixedArgs ?? args;
            Log(logFile, "DEBUG", string.Join("|", argsToUse), "Args passed to real signtool");
            
            return ExecuteRealSigntool(realSigntool, argsToUse);
        }
        
        static string FindFileArgument(string[] args, out string[] fixedArgs)
        {
            fixedArgs = null;
            
            // signtool sign arguments end with the file path(s)
            // Look for the last argument that looks like a file path AND exists
            // Be conservative: if we can't find a clear file target, return null
            // so we pass through to real signtool (safer than accidentally skipping)
            for (int i = args.Length - 1; i >= 0; i--)
            {
                string arg = args[i];
                // Skip arguments that start with / (signtool options)
                if (arg.StartsWith("/")) continue;
                // Skip URLs (timestamp servers)
                if (arg.StartsWith("http://") || arg.StartsWith("https://")) continue;
                
                // Check if it's a signable file extension
                bool isSignableExtension = 
                    arg.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ||
                    arg.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) ||
                    arg.EndsWith(".sys", StringComparison.OrdinalIgnoreCase) ||
                    arg.EndsWith(".msi", StringComparison.OrdinalIgnoreCase) ||
                    arg.EndsWith(".node", StringComparison.OrdinalIgnoreCase);  // Native Node.js modules
                
                if (isSignableExtension)
                {
                    // Verify file exists (prevents false positives from option values)
                    if (File.Exists(arg))
                    {
                        return arg;
                    }
                    
                    // Handle unquoted paths with spaces: Squirrel may pass paths like
                    // "D:\path\Mindstone Rebel Beta_ExecutionStub.exe" as separate args:
                    // args[n]="D:\path\Mindstone", args[n+1]="Rebel", args[n+2]="Beta_ExecutionStub.exe"
                    // Join backward from current position until we find an existing file
                    string joined = arg;
                    string lastValidPath = null;  // Track last path that looks like a valid Windows path
                    int lastValidPathStart = -1;  // Starting index for the valid path
                    for (int j = i - 1; j >= 0; j--)
                    {
                        string prevArg = args[j];
                        // Stop if we hit a signtool option or URL
                        if (prevArg.StartsWith("/") || 
                            prevArg.StartsWith("http://") || 
                            prevArg.StartsWith("https://"))
                        {
                            break;
                        }
                        // Prepend with space separator
                        joined = prevArg + " " + joined;
                        
                        // Track if this looks like a valid Windows path (starts with drive letter)
                        if (joined.Length >= 3 && char.IsLetter(joined[0]) && joined[1] == ':' && joined[2] == '\\')
                        {
                            lastValidPath = joined;
                            lastValidPathStart = j;
                        }
                        
                        if (File.Exists(joined))
                        {
                            // Reconstruct args with the path properly joined
                            // Take args[0..j-1], add joined path
                            fixedArgs = new string[j + 1];
                            for (int k = 0; k < j; k++)
                            {
                                fixedArgs[k] = args[k];
                            }
                            fixedArgs[j] = joined;
                            return joined;
                        }
                    }
                    
                    // Pattern-based fallback: if File.Exists() loop failed but we found a valid-looking
                    // Windows path, check if it matches MustSignPatterns. This handles cases where
                    // Squirrel passes a path for a file that doesn't exist yet (e.g., _ExecutionStub.exe)
                    if (lastValidPath != null)
                    {
                        string normalizedPath = lastValidPath.Replace("/", "\\");
                        foreach (string pattern in MustSignPatterns)
                        {
                            if (Regex.IsMatch(normalizedPath, pattern, RegexOptions.IgnoreCase))
                            {
                                Console.WriteLine("[signtool-wrapper] Pattern match fallback: " + lastValidPath);
                                // Reconstruct args with the path properly joined
                                fixedArgs = new string[lastValidPathStart + 1];
                                for (int k = 0; k < lastValidPathStart; k++)
                                {
                                    fixedArgs[k] = args[k];
                                }
                                fixedArgs[lastValidPathStart] = lastValidPath;
                                return lastValidPath;
                            }
                        }
                    }
                }
            }
            return null;
        }
        
        static bool ShouldExclude(string filePath)
        {
            // Normalize path separators
            string normalizedPath = filePath.Replace("/", "\\");
            
            // First check must-sign patterns - these are NEVER excluded
            foreach (string pattern in MustSignPatterns)
            {
                if (Regex.IsMatch(normalizedPath, pattern, RegexOptions.IgnoreCase))
                {
                    return false; // Must sign, don't exclude
                }
            }
            
            // Check exclusion patterns (using regex for flexibility)
            foreach (string pattern in ExclusionPatterns)
            {
                if (Regex.IsMatch(normalizedPath, pattern, RegexOptions.IgnoreCase))
                {
                    return true; // Exclude from signing
                }
            }
            
            return false; // Don't exclude, sign it
        }
        
        static bool ValidatePEHeader(string filePath, out string error)
        {
            // Validate that a file is a valid PE (Portable Executable) before signing
            // This catches race conditions where the file exists but isn't fully written
            // Returns true if valid, false otherwise with error message
            // 
            // Enhanced validation based on what signtool actually checks:
            // - MZ header, PE signature, COFF header, Optional header, Section table bounds
            error = null;
            
            try
            {
                FileInfo fi = new FileInfo(filePath);
                
                // Check 1: File must have content
                if (fi.Length == 0)
                {
                    error = "File is 0 bytes";
                    return false;
                }
                
                // Check 2: File must be at least 64 bytes (minimum for DOS header)
                if (fi.Length < 64)
                {
                    error = string.Format("File too small for DOS header ({0} bytes)", fi.Length);
                    return false;
                }
                
                using (FileStream fs = File.Open(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    byte[] dosHeader = new byte[64];
                    int bytesRead = fs.Read(dosHeader, 0, 64);
                    
                    if (bytesRead < 64)
                    {
                        error = string.Format("Could only read {0} bytes of DOS header", bytesRead);
                        return false;
                    }
                    
                    // Check 3: Must start with "MZ" (DOS header magic number)
                    if (dosHeader[0] != 0x4D || dosHeader[1] != 0x5A) // 'M' 'Z'
                    {
                        error = string.Format("Invalid MZ header: 0x{0:X2} 0x{1:X2}", dosHeader[0], dosHeader[1]);
                        return false;
                    }
                    
                    // Check 4: e_lfanew (at offset 0x3C) points to PE signature
                    int peOffset = dosHeader[0x3C] | (dosHeader[0x3D] << 8) | (dosHeader[0x3E] << 16) | (dosHeader[0x3F] << 24);
                    
                    // PE offset must be positive and allow for at least PE sig (4) + COFF header (20) + Optional header (min 96)
                    if (peOffset < 0 || peOffset > fi.Length - 124)
                    {
                        error = string.Format("Invalid PE offset: {0} (file size: {1})", peOffset, fi.Length);
                        return false;
                    }
                    
                    // Check 5: Read and verify NT headers (PE sig + COFF header + start of Optional header)
                    fs.Seek(peOffset, SeekOrigin.Begin);
                    byte[] ntHeaders = new byte[128]; // PE sig(4) + COFF(20) + Optional header start(104 for PE32+)
                    bytesRead = fs.Read(ntHeaders, 0, Math.Min(128, (int)(fi.Length - peOffset)));
                    
                    if (bytesRead < 24) // At minimum we need PE sig + COFF header
                    {
                        error = string.Format("Could not read NT headers (got {0} bytes)", bytesRead);
                        return false;
                    }
                    
                    // PE signature is "PE\0\0" (0x50 0x45 0x00 0x00)
                    if (ntHeaders[0] != 0x50 || ntHeaders[1] != 0x45 || ntHeaders[2] != 0x00 || ntHeaders[3] != 0x00)
                    {
                        error = string.Format("Invalid PE signature: 0x{0:X2} 0x{1:X2} 0x{2:X2} 0x{3:X2}",
                            ntHeaders[0], ntHeaders[1], ntHeaders[2], ntHeaders[3]);
                        return false;
                    }
                    
                    // Check 6: Parse COFF header (starts at offset 4 after PE sig)
                    // COFF: Machine(2), NumberOfSections(2), TimeDateStamp(4), PointerToSymbolTable(4),
                    //       NumberOfSymbols(4), SizeOfOptionalHeader(2), Characteristics(2)
                    ushort numberOfSections = (ushort)(ntHeaders[6] | (ntHeaders[7] << 8));
                    ushort sizeOfOptionalHeader = (ushort)(ntHeaders[20] | (ntHeaders[21] << 8));
                    
                    // Sanity check on NumberOfSections (typically < 20 for normal EXEs)
                    if (numberOfSections == 0 || numberOfSections > 96)
                    {
                        error = string.Format("Invalid NumberOfSections: {0}", numberOfSections);
                        return false;
                    }
                    
                    // SizeOfOptionalHeader must be present (at least 96 for PE32, 112 for PE32+)
                    if (sizeOfOptionalHeader < 96)
                    {
                        error = string.Format("Invalid SizeOfOptionalHeader: {0}", sizeOfOptionalHeader);
                        return false;
                    }
                    
                    // Check 7: Verify optional header magic (PE32 = 0x10B, PE32+ = 0x20B)
                    if (bytesRead >= 26)
                    {
                        ushort optionalHeaderMagic = (ushort)(ntHeaders[24] | (ntHeaders[25] << 8));
                        if (optionalHeaderMagic != 0x10B && optionalHeaderMagic != 0x20B)
                        {
                            error = string.Format("Invalid optional header magic: 0x{0:X4}", optionalHeaderMagic);
                            return false;
                        }
                    }
                    
                    // Check 8: Verify section table is within file bounds
                    // Section table starts after: PE sig (4) + COFF header (20) + Optional header
                    long sectionTableOffset = peOffset + 24 + sizeOfOptionalHeader;
                    long sectionTableSize = numberOfSections * 40; // Each section header is 40 bytes
                    
                    if (sectionTableOffset + sectionTableSize > fi.Length)
                    {
                        error = string.Format("Section table exceeds file bounds (offset {0} + size {1} > file {2})",
                            sectionTableOffset, sectionTableSize, fi.Length);
                        return false;
                    }
                    
                    // Check 9: For each section, verify PointerToRawData + SizeOfRawData is within file
                    // This catches truncated files that have valid headers but missing section data
                    fs.Seek(sectionTableOffset, SeekOrigin.Begin);
                    byte[] sectionTable = new byte[sectionTableSize];
                    bytesRead = fs.Read(sectionTable, 0, (int)sectionTableSize);
                    
                    if (bytesRead < sectionTableSize)
                    {
                        error = string.Format("Could not read section table (got {0} of {1} bytes)", bytesRead, sectionTableSize);
                        return false;
                    }
                    
                    for (int i = 0; i < numberOfSections; i++)
                    {
                        int offset = i * 40;
                        // SizeOfRawData at offset 16, PointerToRawData at offset 20
                        uint sizeOfRawData = (uint)(sectionTable[offset + 16] | (sectionTable[offset + 17] << 8) |
                            (sectionTable[offset + 18] << 16) | (sectionTable[offset + 19] << 24));
                        uint pointerToRawData = (uint)(sectionTable[offset + 20] | (sectionTable[offset + 21] << 8) |
                            (sectionTable[offset + 22] << 16) | (sectionTable[offset + 23] << 24));
                        
                        // Skip sections with no raw data (like .bss)
                        if (sizeOfRawData == 0) continue;
                        
                        if (pointerToRawData + sizeOfRawData > (ulong)fi.Length)
                        {
                            // Get section name (first 8 bytes)
                            string sectionName = System.Text.Encoding.ASCII.GetString(sectionTable, offset, 8).TrimEnd('\0');
                            error = string.Format("Section '{0}' exceeds file bounds (offset {1} + size {2} > file {3})",
                                sectionName, pointerToRawData, sizeOfRawData, fi.Length);
                            return false;
                        }
                    }
                    
                    // All checks passed - this is a structurally valid PE file
                    return true;
                }
            }
            catch (IOException ioEx)
            {
                error = "IO error: " + ioEx.Message;
                return false;
            }
            catch (Exception ex)
            {
                error = "Error: " + ex.Message;
                return false;
            }
        }
        
        static void Log(string logFile, string action, string filePath, string reason)
        {
            if (string.IsNullOrEmpty(logFile)) return;
            
            try
            {
                string timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff");
                string logLine = string.Format("{0} | {1} | {2} | {3}", timestamp, action, reason, filePath);
                File.AppendAllText(logFile, logLine + Environment.NewLine);
            }
            catch
            {
                // Ignore logging errors - don't fail the build
            }
        }
        
        static void DumpPeDiagnostics(string filePath, string logFile)
        {
            // Dump detailed PE diagnostics when signtool fails with 0x800700C1
            // Focus on IMAGE_DIRECTORY_ENTRY_SECURITY (Certificate Table) which is index 4
            try
            {
                using (FileStream fs = File.Open(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    FileInfo fi = new FileInfo(filePath);
                    Log(logFile, "DIAG", filePath, string.Format("File size: {0} bytes", fi.Length));
                    
                    // Read DOS header
                    byte[] dosHeader = new byte[64];
                    fs.Read(dosHeader, 0, 64);
                    int peOffset = dosHeader[0x3C] | (dosHeader[0x3D] << 8) | (dosHeader[0x3E] << 16) | (dosHeader[0x3F] << 24);
                    
                    // Seek to PE header
                    fs.Seek(peOffset, SeekOrigin.Begin);
                    byte[] peHeader = new byte[256];
                    int bytesRead = fs.Read(peHeader, 0, 256);
                    
                    // COFF header (starts at PE+4)
                    ushort machine = (ushort)(peHeader[4] | (peHeader[5] << 8));
                    ushort numberOfSections = (ushort)(peHeader[6] | (peHeader[7] << 8));
                    ushort sizeOfOptionalHeader = (ushort)(peHeader[20] | (peHeader[21] << 8));
                    ushort characteristics = (ushort)(peHeader[22] | (peHeader[23] << 8));
                    
                    Log(logFile, "DIAG", filePath, string.Format(
                        "COFF: Machine=0x{0:X4}, Sections={1}, OptHeaderSize={2}, Characteristics=0x{3:X4}",
                        machine, numberOfSections, sizeOfOptionalHeader, characteristics));
                    
                    // Optional header (starts at PE+24)
                    ushort magic = (ushort)(peHeader[24] | (peHeader[25] << 8));
                    bool isPE32Plus = (magic == 0x20B);
                    
                    int fileAlignmentOffset = isPE32Plus ? 44 : 36;
                    int sizeOfHeadersOffset = isPE32Plus ? 60 : 52;
                    int checkSumOffset = isPE32Plus ? 64 : 56;
                    int numberOfRvaAndSizesOffset = isPE32Plus ? 108 : 92;
                    int dataDirOffset = isPE32Plus ? 112 : 96;
                    
                    uint fileAlignment = (uint)(peHeader[24 + fileAlignmentOffset] | 
                        (peHeader[24 + fileAlignmentOffset + 1] << 8) |
                        (peHeader[24 + fileAlignmentOffset + 2] << 16) | 
                        (peHeader[24 + fileAlignmentOffset + 3] << 24));
                    
                    uint sizeOfHeaders = (uint)(peHeader[24 + sizeOfHeadersOffset] | 
                        (peHeader[24 + sizeOfHeadersOffset + 1] << 8) |
                        (peHeader[24 + sizeOfHeadersOffset + 2] << 16) | 
                        (peHeader[24 + sizeOfHeadersOffset + 3] << 24));
                    
                    uint checkSum = (uint)(peHeader[24 + checkSumOffset] | 
                        (peHeader[24 + checkSumOffset + 1] << 8) |
                        (peHeader[24 + checkSumOffset + 2] << 16) | 
                        (peHeader[24 + checkSumOffset + 3] << 24));
                    
                    uint numberOfRvaAndSizes = (uint)(peHeader[24 + numberOfRvaAndSizesOffset] | 
                        (peHeader[24 + numberOfRvaAndSizesOffset + 1] << 8) |
                        (peHeader[24 + numberOfRvaAndSizesOffset + 2] << 16) | 
                        (peHeader[24 + numberOfRvaAndSizesOffset + 3] << 24));
                    
                    Log(logFile, "DIAG", filePath, string.Format(
                        "Optional: Magic=0x{0:X4} ({1}), FileAlign={2}, SizeOfHeaders={3}, CheckSum=0x{4:X8}, NumDataDir={5}",
                        magic, isPE32Plus ? "PE32+" : "PE32", fileAlignment, sizeOfHeaders, checkSum, numberOfRvaAndSizes));
                    
                    // Check Machine/Magic coherence
                    bool machineMatchesMagic = (machine == 0x8664 && isPE32Plus) || (machine == 0x14c && !isPE32Plus);
                    Log(logFile, "DIAG", filePath, string.Format("Machine/Magic coherence: {0}", machineMatchesMagic ? "PASS" : "FAIL"));
                    
                    // Read Security Directory (index 4) - each data dir entry is 8 bytes (RVA + Size)
                    if (numberOfRvaAndSizes >= 5)
                    {
                        int secDirFileOffset = 24 + dataDirOffset + (4 * 8); // index 4 * 8 bytes per entry
                        if (secDirFileOffset + 8 <= bytesRead)
                        {
                            uint secRva = (uint)(peHeader[secDirFileOffset] | (peHeader[secDirFileOffset + 1] << 8) |
                                (peHeader[secDirFileOffset + 2] << 16) | (peHeader[secDirFileOffset + 3] << 24));
                            uint secSize = (uint)(peHeader[secDirFileOffset + 4] | (peHeader[secDirFileOffset + 5] << 8) |
                                (peHeader[secDirFileOffset + 6] << 16) | (peHeader[secDirFileOffset + 7] << 24));
                            
                            Log(logFile, "DIAG", filePath, string.Format(
                                "Security Directory (cert table): Offset={0} (0x{0:X}), Size={1}", secRva, secSize));
                            
                            if (secSize > 0)
                            {
                                // Check alignment (Authenticode requires 8-byte alignment)
                                bool offsetAligned = (secRva % 8) == 0;
                                bool sizeAligned = (secSize % 8) == 0;
                                bool withinFile = (secRva + secSize) <= (ulong)fi.Length;
                                
                                Log(logFile, "DIAG", filePath, string.Format(
                                    "Security Dir checks: OffsetAligned8={0}, SizeAligned8={1}, WithinFile={2}",
                                    offsetAligned ? "PASS" : "FAIL", sizeAligned ? "PASS" : "FAIL", withinFile ? "PASS" : "FAIL"));
                                
                                // Try to read WIN_CERTIFICATE header
                                if (withinFile && secRva > 0)
                                {
                                    fs.Seek(secRva, SeekOrigin.Begin);
                                    byte[] certHeader = new byte[8];
                                    if (fs.Read(certHeader, 0, 8) == 8)
                                    {
                                        uint dwLength = (uint)(certHeader[0] | (certHeader[1] << 8) |
                                            (certHeader[2] << 16) | (certHeader[3] << 24));
                                        ushort wRevision = (ushort)(certHeader[4] | (certHeader[5] << 8));
                                        ushort wCertificateType = (ushort)(certHeader[6] | (certHeader[7] << 8));
                                        
                                        Log(logFile, "DIAG", filePath, string.Format(
                                            "WIN_CERTIFICATE: dwLength={0}, wRevision=0x{1:X4}, wCertificateType=0x{2:X4}",
                                            dwLength, wRevision, wCertificateType));
                                        
                                        // Expected: wRevision = 0x0200 (WIN_CERT_REVISION_2_0), wCertificateType = 0x0002 (WIN_CERT_TYPE_PKCS_SIGNED_DATA)
                                        bool validRevision = (wRevision == 0x0100 || wRevision == 0x0200);
                                        bool validType = (wCertificateType == 0x0001 || wCertificateType == 0x0002);
                                        Log(logFile, "DIAG", filePath, string.Format(
                                            "WIN_CERTIFICATE validity: Revision={0}, Type={1}",
                                            validRevision ? "PASS" : "FAIL", validType ? "PASS" : "FAIL"));
                                    }
                                }
                            }
                            else
                            {
                                Log(logFile, "DIAG", filePath, "Security Directory is empty (no existing signature)");
                            }
                        }
                    }
                    else
                    {
                        Log(logFile, "DIAG", filePath, string.Format("NumberOfRvaAndSizes ({0}) < 5, no Security Directory", numberOfRvaAndSizes));
                    }
                }
            }
            catch (Exception ex)
            {
                Log(logFile, "DIAG", filePath, "Error dumping PE diagnostics: " + ex.Message);
            }
        }
        
        static int ExecuteRealSigntool(string realSigntool, string[] args)
        {
            string logFile = Environment.GetEnvironmentVariable("SIGNTOOL_WRAPPER_LOG") ?? DefaultLogFile;
            
            if (!File.Exists(realSigntool))
            {
                Console.Error.WriteLine("[signtool-wrapper] ERROR: Real signtool not found: " + realSigntool);
                return 1;
            }
            
            // Build argument string
            string arguments = string.Join(" ", Array.ConvertAll(args, arg =>
            {
                // Quote arguments containing spaces
                if (arg.Contains(" "))
                    return "\"" + arg + "\"";
                return arg;
            }));
            
            // Log the actual command line being executed
            Log(logFile, "DEBUG", arguments, "Final command line to signtool");
            
            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = realSigntool,
                Arguments = arguments,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            
            using (Process process = Process.Start(psi))
            {
                // Capture output for logging
                System.Text.StringBuilder stdout = new System.Text.StringBuilder();
                System.Text.StringBuilder stderr = new System.Text.StringBuilder();
                
                // Stream output in real-time
                process.OutputDataReceived += (sender, e) =>
                {
                    if (e.Data != null)
                    {
                        Console.WriteLine(e.Data);
                        stdout.AppendLine(e.Data);
                    }
                };
                process.ErrorDataReceived += (sender, e) =>
                {
                    if (e.Data != null)
                    {
                        Console.Error.WriteLine(e.Data);
                        stderr.AppendLine(e.Data);
                    }
                };
                
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                
                int exitCode = process.ExitCode;
                
                // Log the exit code and any output
                if (exitCode != 0)
                {
                    Log(logFile, "ERROR", exitCode.ToString(), "Signtool exit code");
                    if (stderr.Length > 0)
                    {
                        Log(logFile, "ERROR", stderr.ToString().Trim(), "Signtool stderr");
                    }
                    if (stdout.Length > 0)
                    {
                        Log(logFile, "ERROR", stdout.ToString().Trim(), "Signtool stdout");
                    }
                    
                    // If we got 0x800700C1 (ERROR_BAD_EXE_FORMAT), dump PE diagnostics
                    string stderrStr = stderr.ToString();
                    if (stderrStr.Contains("0x800700C1") || stderrStr.Contains("badexeformat"))
                    {
                        // Find the file path from args (last .exe/.dll argument)
                        string failingFile = null;
                        for (int i = args.Length - 1; i >= 0; i--)
                        {
                            if (args[i].EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ||
                                args[i].EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
                            {
                                failingFile = args[i];
                                break;
                            }
                        }
                        
                        if (failingFile != null && File.Exists(failingFile))
                        {
                            Log(logFile, "DIAG", failingFile, "=== PE DIAGNOSTICS FOR 0x800700C1 ===");
                            DumpPeDiagnostics(failingFile, logFile);
                        }
                    }
                }
                else
                {
                    Log(logFile, "DEBUG", exitCode.ToString(), "Signtool exit code (success)");
                }
                
                return exitCode;
            }
        }
    }
}
"@

# Find csc.exe (C# compiler)
$cscPath = $null
$frameworkPaths = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)

foreach ($path in $frameworkPaths) {
    if (Test-Path $path) {
        $cscPath = $path
        break
    }
}

if (-not $cscPath) {
    Write-Host "ERROR: Could not find csc.exe (.NET Framework compiler)" -ForegroundColor Red
    Write-Host "Searched paths:" -ForegroundColor Yellow
    $frameworkPaths | ForEach-Object { Write-Host "  $_" }
    exit 1
}

Write-Host "Found C# compiler: $cscPath" -ForegroundColor Green

# Write C# source to temp file
$tempSourceFile = "$env:TEMP\signtool-wrapper.cs"
[System.IO.File]::WriteAllText($tempSourceFile, $csharpSource)
Write-Host "Generated C# source: $tempSourceFile" -ForegroundColor Gray

# Ensure output directory exists
$outputDir = Split-Path -Parent $OutputPath
if ($outputDir -and -not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

# Compile the wrapper
Write-Host "Compiling wrapper..." -ForegroundColor Cyan
$compileArgs = @(
    "/target:exe",
    "/out:$OutputPath",
    "/optimize+",
    $tempSourceFile
)

$compileProcess = Start-Process -FilePath $cscPath -ArgumentList $compileArgs -Wait -PassThru -NoNewWindow
if ($compileProcess.ExitCode -ne 0) {
    Write-Host "ERROR: Compilation failed with exit code $($compileProcess.ExitCode)" -ForegroundColor Red
    exit 1
}

# Verify output exists
if (-not (Test-Path $OutputPath)) {
    Write-Host "ERROR: Compiled wrapper not found at: $OutputPath" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=== Wrapper Created Successfully ===" -ForegroundColor Green
Write-Host "Output: $OutputPath" -ForegroundColor Gray
Write-Host ""
Write-Host "Exclusion patterns:" -ForegroundColor Cyan
Write-Host "  - *\resources\git-bundle\*" -ForegroundColor Gray
Write-Host "  - *\resources\node-bundle\*" -ForegroundColor Gray
Write-Host "  - *\dummy.node (zero-byte placeholder)" -ForegroundColor Gray
Write-Host ""
Write-Host "Must-sign patterns (never excluded):" -ForegroundColor Cyan
Write-Host "  - *Mindstone Rebel Beta.exe" -ForegroundColor Gray
Write-Host "  - *Mindstone Rebel.exe" -ForegroundColor Gray
Write-Host "  - *_ExecutionStub.exe" -ForegroundColor Gray
Write-Host "  - *\squirrel.exe" -ForegroundColor Gray
Write-Host "  - *\Update.exe" -ForegroundColor Gray
Write-Host ""
Write-Host "Environment variables:" -ForegroundColor Cyan
Write-Host "  REAL_SIGNTOOL_PATH - Override path to real signtool" -ForegroundColor Gray
Write-Host "  SIGNTOOL_WRAPPER_LOG - Path to log signing decisions" -ForegroundColor Gray

# Cleanup temp file
Remove-Item -LiteralPath $tempSourceFile -Force -ErrorAction SilentlyContinue

exit 0
