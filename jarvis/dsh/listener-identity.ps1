param([ValidateRange(0, 65535)][int]$QueryPort = 0)
$ErrorActionPreference = 'Stop'

if (!('JarvisLauncherTcp' -as [type])) {
  # Shared by startup coordination and the host's readiness publication. The
  # numeric OS table is independent of netstat's translated display text.
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class JarvisLauncherTcp {
  [DllImport("iphlpapi.dll", SetLastError = true)]
  private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool sorted, int family, int tableClass, int reserved);
  public static int[] ListenerPids(int port) {
    var exact = new List<int>();
    var wildcard = new List<int>();
    int size = 0;
    // AF_INET + TCP_TABLE_OWNER_PID_LISTENER. Windows also exposes the IPv4
    // side of dual-stack listeners here; IPv6-only sockets do not reserve IPv4.
    uint status = GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 3, 0);
    if (status != 0 && status != 122) throw new InvalidOperationException("Cannot inspect local TCP listeners.");
    while (size > 0) {
      IntPtr table = Marshal.AllocHGlobal(size);
      try {
        status = GetExtendedTcpTable(table, ref size, false, 2, 3, 0);
        if (status == 122) continue;
        if (status != 0) throw new InvalidOperationException("Cannot inspect local TCP listeners.");
        int rows = Marshal.ReadInt32(table);
        int loopback = BitConverter.ToInt32(new byte[] { 127, 0, 0, 1 }, 0);
        for (int row = 0; row < rows; row++) {
          // MIB_TCPROW_OWNER_PID: state, address, port, remote address/port, PID.
          int offset = 4 + row * 24;
          int localAddress = Marshal.ReadInt32(table, offset + 4);
          if (localAddress != 0 && localAddress != loopback) continue;
          int localPort = (Marshal.ReadByte(table, offset + 8) << 8) | Marshal.ReadByte(table, offset + 9);
          if (localPort != port) continue;
          int pid = Marshal.ReadInt32(table, offset + 20);
          var owners = localAddress == loopback ? exact : wildcard;
          if (!owners.Contains(pid)) owners.Add(pid);
        }
        break;
      } finally { Marshal.FreeHGlobal(table); }
    }
    // Windows routes this endpoint to a specific bind ahead of a co-bound
    // wildcard. An unrelated wildcard cannot invalidate an exact owner's PID.
    return exact.Count > 0 ? exact.ToArray() : wildcard.ToArray();
  }
}
'@
}

if ($QueryPort) {
  ConvertTo-Json -InputObject @([JarvisLauncherTcp]::ListenerPids($QueryPort)) -Compress
}
