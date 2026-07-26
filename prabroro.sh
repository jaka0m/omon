#!/bin/bash

ulimit -n 65535
ulimit -s unlimited

# ====================================================
# 🚀 ULTRA TURBO KERNEL v3.2 (PURE STANDARD FOR GOLANG + OPENSSH) 🚀
# ====================================================
echo "[*] Mengaktifkan TCP BBR dan Fair Queuing..."
sysctl -w net.core.default_qdisc=fq 2>/dev/null
sysctl -w net.ipv4.tcp_congestion_control=bbr 2>/dev/null

echo "[*] Mengoptimalkan ukuran buffer TCP Kernel (BUFFER RAKSASA)..."
sysctl -w net.ipv4.tcp_rmem="4096 8388608 16777216" 2>/dev/null
sysctl -w net.ipv4.tcp_wmem="4096 8388608 16777216" 2>/dev/null
sysctl -w net.core.rmem_max=16777216 2>/dev/null
sysctl -w net.core.wmem_max=16777216 2>/dev/null

# Kelonggaran antrean kartu jaringan agar engine Go-routine melesat lempeng
sysctl -w net.core.netdev_max_backlog=50000 2>/dev/null
sysctl -w net.ipv4.tcp_max_syn_backlog=8192 2>/dev/null

# --- PARSING /app/jokowi TERPERCAYA (TANPA TITIK) ---
if [ -f "/app/jokowi" ]; then
    echo "[*] Membaca konfigurasi dari /app/jokowi..."
    while IFS= read -r line || [ -n "$line" ]; do
        # Abaikan komentar dan baris kosong
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${line// }" ]] && continue

        # Bersihkan spasi dan tanda kutip, lalu export variabelnya
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            key="${BASH_REMATCH[1]}"
            val="${BASH_REMATCH[2]}"
            # Hilangkan kutip ganda atau kutip tunggal pembungkus jika ada
            val="${val%\"}"
            val="${val#\"}"
            val="${val%\'}"
            val="${val#\'}"
            export "$key"="$val"
        fi
    done < "/app/jokowi"
fi

USER_NAME="${SSH_USER:-dd}"
USER_PASS="${SSH_PASSWORD:-dd}"
PUBLIC_PORT="${PORT:-3000}"
SSL_INTERNAL_PORT="${SSL_INTERNAL_PORT:-2443}"
ARGO_PORT="8001"

echo "[*] Membuat sertifikat SSL Stunnel dinamis..."
mkdir -p /etc/stunnel /var/run/stunnel
openssl req -new -newkey rsa:2048 -days 365 -nodes -x509 \
    -subj "/C=ID/ST=Jakarta/L=Jakarta/O=RailwaySSH/CN=localhost" \
    -keyout /etc/stunnel/stunnel.pem -out /etc/stunnel/stunnel.pem

chown -R stunnel:stunnel /etc/stunnel /var/run/stunnel
chmod 600 /etc/stunnel/stunnel.pem

echo "[*] Mengonfigurasi User SSH (Alpine Mode)..."
if ! id "$USER_NAME" &>/dev/null; then
    adduser -D -s /bin/bash "$USER_NAME"
    echo "$USER_NAME ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
fi
echo "$USER_NAME:$USER_PASS" | chpasswd

echo "[*] Membuat Banner Rapi untuk OpenSSH..."
cat << BANNER_HTML > /etc/ssh/ssh_banner
<p style="text-align:center">
<font color="green"><b></b></font><br>
<font color="green"><b></b></font><br>
<font color="blue"><b>SPESIFIKASI :</b></font><br>
<font color="yellow"><b>Multiplexer : Golang High-speed Core v3.2</b></font><br>
<font color="yellow"><b>OS Platform : Linux Alpine (Ram Monster Mode)</b></font><br>
<font color="yellow"><b>SSH Service : Openssh Server High Compat</b></font><br>
<font color="blue"><b>Mod by : Geo Project</b></font><br>
<font color="green"><b></b></font><br>
<font color="green"><b></b></font><br>
</p>
BANNER_HTML

echo "[*] Menyiapkan Host Keys untuk OpenSSH..."
ssh-keygen -A

echo "[*] Membuat konfigurasi OpenSSH Suci Murni (Anti-Rekonek Version)..."
cat << 'EOF' > /etc/ssh/sshd_config
Port 22
ListenAddress 127.0.0.1
PermitRootLogin yes
PasswordAuthentication yes
PermitEmptyPasswords no
ChallengeResponseAuthentication no
UsePAM no
X11Forwarding no
PrintMotd no
AcceptEnv LANG LC_*
Subsystem sftp /usr/lib/ssh/sftp-server
Banner /etc/ssh/ssh_banner

# 🛠 KUNCI UTAMA ANTI TIMEOUT:
# Mengaktifkan loose DNS check agar jabat tangan asinkronus lebih lancar
UseDNS no

# SAKLAR TIMEOUT JALUR: Server maksa ping ke HP tiap 20 detik biar Cloudflare gak mutus sepihak
ClientAliveInterval 20
ClientAliveCountMax 3
EOF

echo "[*] Memulai OpenSSH Server di Port Lokal 22..."
/usr/sbin/sshd

echo "[*] Membuat konfigurasi Stunnel..."
cat <<EOF > /etc/stunnel/stunnel.conf
pid = /var/run/stunnel.pid
foreground = yes
debug = 4
setuid = stunnel
setgid = stunnel

[ssh-ssl]
accept = 127.0.0.1:$SSL_INTERNAL_PORT
connect = 127.0.0.1:22
cert = /etc/stunnel/stunnel.pem
EOF

echo "[*] Menambahkan sesuatu di .bashrc..."
cat <<'EOF'>> /etc/bash.bashrc
clear
alias c='clear'
alias x='exit'
alias cls='clear;ls'
EOF
echo "source /etc/bash.bashrc" >> /home/"$USER_NAME"/.bashrc

echo "[*] Memulai Stunnel..."
stunnel /etc/stunnel/stunnel.conf &

# --- Argo Tunnel (cloudflared) ---
if [ -n "$ARGO_AUTH" ]; then
    echo "[*] Menjalankan Cloudflare Tunnel (Low Latency Mode) dengan Token..."
    # Ketika menggunakan Token resmi, jalankan run --token dan tunjuk protkol http2
    cloudflared tunnel --protocol http2 run --token "$ARGO_AUTH" &
fi

# --- TAMBAHAN UTAMA: BADVPN UDPGW UNTUK MENDUKUNG TRAFIK UDP / GAME ---
if [ -f /usr/local/bin/badvpn-udpgw ]; then
    echo "[*] Memulai BadVPN udpgw di Port Lokal 7300..."
    /usr/local/bin/badvpn-udpgw --listen-addr 127.0.0.1:7300 --max-clients 500 --max-connections-for-client 20 &
else
    echo "[!] Binary badvpn-udpgw tidak ditemukan!"
fi

echo "[*] Memulai Node.js Gateway Core..."
# Menjalankan Node.js app di background
node /app/index.js &

echo "[*] Memulai Front Muxer Engine Utama (Golang Mode)..."
export PORT="$PUBLIC_PORT"
export SSL_TARGET_HOST="127.0.0.1"
export SSL_TARGET_PORT="$SSL_INTERNAL_PORT"
export WS_MUX_TARGET_HOST="127.0.0.1"
export WS_MUX_TARGET_PORT="$ARGO_PORT"

# Menjalankan Muxer utama di foreground
exec mux
