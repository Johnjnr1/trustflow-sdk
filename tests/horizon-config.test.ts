import { TrustFlowClient } from "../src/client";
import { TrustFlowError } from "../src/errors";
import { ClientConfigSchema } from "../src/schemas";
import { Horizon } from "@stellar/stellar-sdk";

describe("Horizon & Network Config Overrides (#208)", () => {
  const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const customHorizon = "https://custom-horizon.example.com";
  const customRpc = "https://custom-soroban-rpc.example.com";
  const customPassphrase = "Private Test Network ; 2026";

  it("accepts custom horizonUrl and networkPassphrase in ClientConfig", () => {
    const client = new TrustFlowClient({
      contractId,
      horizonUrl: customHorizon,
      rpcUrl: customRpc,
      networkPassphrase: customPassphrase,
    });

    const config = client.getConfig();
    expect(config.horizonUrl).toBe(customHorizon);
    expect(config.rpcUrl).toBe(customRpc);
    expect(config.networkPassphrase).toBe(customPassphrase);
    expect(client.getNetworkPassphrase()).toBe(customPassphrase);
    expect((client.getServer() as any).serverURL.toString()).toBe("https://custom-horizon.example.com/");
  });

  it("validates horizonUrl and rpcUrl throwing INVALID_CONFIG when malformed", () => {
    expect(() => {
      new TrustFlowClient({
        contractId,
        horizonUrl: "not-a-url",
      });
    }).toThrow(TrustFlowError);

    try {
      new TrustFlowClient({
        contractId,
        horizonUrl: "not-a-url",
      });
    } catch (err: any) {
      expect(err.code).toBe("INVALID_CONFIG");
    }

    expect(() => {
      new TrustFlowClient({
        contractId,
        rpcUrl: "not-a-url",
      });
    }).toThrow(TrustFlowError);
  });

  it("ClientConfigSchema validates horizonUrl and networkPassphrase", () => {
    const valid = ClientConfigSchema.safeParse({
      contractId,
      network: "TESTNET",
      horizonUrl: customHorizon,
      rpcUrl: customRpc,
      networkPassphrase: customPassphrase,
    });
    expect(valid.success).toBe(true);

    const invalid = ClientConfigSchema.safeParse({
      contractId,
      horizonUrl: "bad-url",
    });
    expect(invalid.success).toBe(false);

    expect(ClientConfigSchema.safeParse({
      contractId,
      networkPassphrase: '   ',
    }).success).toBe(false);
  });
});
