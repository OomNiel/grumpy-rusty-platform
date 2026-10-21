/**
 * The other end of the clock hand-over: a listener that answers the board when it asks.
 *
 * The firmware side of the clock is a request, not a read -- a board cannot know what a PC's clock
 * says. `TIME?` goes out on the console once a second while the chip's RTC has never been set, and
 * whatever owns the serial port answers with the same `TIME HH:MM:SS` line a flash writes. This is
 * that answer, kept in a terminal for as long as the design is open: a board loses its RTC time when
 * the power goes, so a cold boot asks again, and a listener that had stopped would leave it waiting.
 *
 * Why a shell line and not a serial library: the extension already writes its one line with `stty`
 * and a redirect (`writeSerialLineCommand`), and a listener changes the shape of that command rather
 * than the choice. The port is opened **once** -- `exec 3<>` and PowerShell's SerialPort both keep a
 * single handle -- because opening a tty drops DTR and resets an ESP on many boards, which would turn
 * "answer the time" into "reboot the board".
 *
 * The rules are the same ones `clockSync` follows, and for the same reason:
 *
 * - **A design with no clock is refused.** Nothing on the glass would follow an answer.
 * - **No port is refused, not guessed.** A listener that picks between two boards is worse than one
 *   that says it needs a port.
 * - **The port has to be free.** Monitor holds it for as long as its terminal is open; the shell will
 *   say so, and the message names Monitor so the user knows what to close.
 */

/** What starting the listener will do, or why it will not. */
export type ClockHostPlan =
    | { kind: 'serve'; port: string; command: string }
    | { kind: 'refuse'; message: string };

/**
 * Decide whether the listener can start, before a terminal is opened.
 *
 * Pure, so the refusal sentences and the exact command are testable without a serial port.
 */
export function clockHostPlan(options: {
    hasClock: boolean;
    port?: string;
    platform?: NodeJS.Platform;
}): ClockHostPlan {
    if (!options.hasClock) {
        return {
            kind: 'refuse',
            message: 'This design has no clock widget, so the board has nothing to ask the time for.',
        };
    }
    const port = (options.port ?? '').trim();
    if (port === '') {
        return {
            kind: 'refuse',
            message:
                'No module is on a serial port. Connect the board, or set "rustyPlatform.serialPort" to the ' +
                'port it appears on.',
        };
    }
    return { kind: 'serve', port, command: clockHostCommand(port, options.platform ?? process.platform) };
}

/**
 * The shell line that keeps the port open and answers `TIME?` with the PC's local time.
 *
 * The hello (`RUSTY?`) is load-bearing on a board whose USB socket goes through a bridge -- the CYD
 * cannot see the cable, so a byte arriving is its first evidence that a host exists. It is repeated
 * for a few seconds because opening a serial port usually resets an ESP (DTR is wired to EN), and a
 * single hello sent while the board is still booting would be lost.
 *
 * **It answers every request, for as long as the terminal is open.** One answer is not enough: a
 * board's RTC loses its time when the power goes, so a cold boot makes it ask again -- and a listener
 * that had already let go would leave the hands frozen with the PC sitting right there. The port is
 * released when the terminal is closed (the designer panel's dispose, a flash, or Monitor), which is
 * the only moment it is actually wanted by someone else. The handle is opened once (`exec 3<>`), and
 * `-hupcl` keeps DTR up when it is closed, so neither starting nor stopping resets the board.
 */
export function clockHostCommand(port: string, platform: NodeJS.Platform = process.platform): string {
    if (platform === 'win32') {
        // `[char]10` rather than a backtick-n: this line travels through a JavaScript template.
        return (
            `$p = [System.IO.Ports.SerialPort]::new('${port}', 115200); $p.Open(); ` +
            `$p.NewLine = [string][char]10; ` +
            `for ($i = 0; $i -lt 10; $i++) { $p.WriteLine('RUSTY?'); Start-Sleep -Milliseconds 300 }; ` +
            `while ($true) { $p.ReadTimeout = 1000; ` +
            `try { $line = $p.ReadLine() } catch { $line = $null }; ` +
            `if ($line -and $line.Contains('TIME?')) { ` +
            `$answer = 'TIME ' + (Get-Date).ToString('HH:mm:ss'); $p.WriteLine($answer); ` +
            `Write-Host ('clock: ' + $answer) } }`
        );
    }
    // One handle for both directions (fd 3). `-hupcl` keeps DTR up when the port is closed, so
    // stopping the listener does not reset the board. `-F` is GNU stty and `-f` is BSD/macOS.
    return (
        `(stty -F "${port}" 115200 raw -echo -hupcl 2>/dev/null || stty -f "${port}" 115200 raw -echo -hupcl) && ` +
        `exec 3<>"${port}" || { echo 'clock: the port could not be opened (is Monitor holding it?)'; exit 1; }; ` +
        `for i in 1 2 3 4 5 6 7 8 9 10; do printf 'RUSTY?\\n' >&3; sleep 0.3; done; ` +
        `while IFS= read -r line <&3; do ` +
        `case "$line" in *"TIME?"*) answer=$(date +%H:%M:%S); ` +
        `printf 'TIME %s\\n' "$answer" >&3; echo "clock: time sent ($answer)";; esac; ` +
        `done; ` +
        `exec 3>&-`
    );
}
