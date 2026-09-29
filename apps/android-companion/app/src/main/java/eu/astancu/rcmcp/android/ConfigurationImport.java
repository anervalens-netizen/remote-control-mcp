package eu.astancu.rcmcp.android;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/** Strict, bounded JSON object of three strings. No provisioning side effects. */
final class ConfigurationImport {
    static final int MAX_BYTES = 8192;
    final String endpoint;
    final String device;
    final String token;

    private ConfigurationImport(Map<String, String> values) {
        if (values.size() != 3 || !values.containsKey("endpoint") || !values.containsKey("device")
                || !values.containsKey("token")) throw invalid();
        endpoint = EndpointValidator.validateAndNormalize(values.get("endpoint"));
        device = values.get("device").trim();
        token = values.get("token");
        if (!PairingValidator.validDeviceId(device) || !PairingValidator.validToken(token)) throw invalid();
    }

    static ConfigurationImport read(InputStream input) throws IOException {
        if (input == null) throw invalid();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] chunk = new byte[1024];
        while (true) {
            int count = input.read(chunk, 0, Math.min(chunk.length, MAX_BYTES + 1 - bytes.size()));
            if (count < 0) break;
            if (count == 0) throw invalid();
            bytes.write(chunk, 0, count);
            if (bytes.size() > MAX_BYTES) throw invalid();
        }
        return parse(bytes.toByteArray());
    }

    static ConfigurationImport parse(byte[] bytes) {
        if (bytes == null || bytes.length > MAX_BYTES) throw invalid();
        try {
            String json = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            Parser parser = new Parser(json);
            Map<String, String> values = new HashMap<>();
            parser.expect('{');
            do {
                String key = parser.string();
                if (!key.equals("endpoint") && !key.equals("device") && !key.equals("token")) throw invalid();
                parser.expect(':');
                if (values.put(key, parser.string()) != null) throw invalid();
            } while (parser.take(','));
            parser.expect('}');
            parser.whitespace();
            if (parser.offset != json.length()) throw invalid();
            return new ConfigurationImport(values);
        } catch (CharacterCodingException invalidUtf8) {
            throw invalid();
        }
    }

    private static IllegalArgumentException invalid() { return new IllegalArgumentException("configuration_import_invalid"); }

    private static final class Parser {
        final String text;
        int offset;
        Parser(String text) { this.text = text; }
        void whitespace() {
            while (offset < text.length() && " \t\r\n".indexOf(text.charAt(offset)) >= 0) offset++;
        }
        boolean take(char value) {
            whitespace();
            if (offset < text.length() && text.charAt(offset) == value) { offset++; return true; }
            return false;
        }
        void expect(char value) { if (!take(value)) throw invalid(); }
        String string() {
            expect('"');
            StringBuilder result = new StringBuilder();
            while (offset < text.length()) {
                char c = text.charAt(offset++);
                if (c == '"') {
                    String value = result.toString();
                    for (int i = 0; i < value.length(); i++) {
                        char unit = value.charAt(i);
                        if (Character.isHighSurrogate(unit)) {
                            if (++i >= value.length() || !Character.isLowSurrogate(value.charAt(i))) throw invalid();
                        } else if (Character.isLowSurrogate(unit)) throw invalid();
                    }
                    return value;
                }
                if (c < 0x20) throw invalid();
                if (c == '\\') {
                    if (offset >= text.length()) throw invalid();
                    char escape = text.charAt(offset++);
                    c = switch (escape) {
                        case '"', '\\', '/' -> escape;
                        case 'b' -> '\b';
                        case 'f' -> '\f';
                        case 'n' -> '\n';
                        case 'r' -> '\r';
                        case 't' -> '\t';
                        case 'u' -> unicode();
                        default -> throw invalid();
                    };
                }
                result.append(c);
            }
            throw invalid();
        }
        char unicode() {
            int value = 0;
            for (int i = 0; i < 4; i++) {
                if (offset >= text.length()) throw invalid();
                char c = text.charAt(offset++);
                int digit = "0123456789abcdef".indexOf(Character.toLowerCase(c));
                if (digit < 0) throw invalid();
                value = value * 16 + digit;
            }
            return (char) value;
        }
    }
}
