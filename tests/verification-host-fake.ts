import type { SupernoteVerificationChallenge } from "../src/cloud/client";
import type { VerificationHost } from "../src/ui/verification-modal";

export class FakeVerificationHost implements VerificationHost {
  readonly verificationAttempts: Array<{
    challenge: SupernoteVerificationChallenge;
    code: string;
  }> = [];
  readonly resendAttempts: SupernoteVerificationChallenge[] = [];

  async verifyLogin(
    challenge: SupernoteVerificationChallenge,
    code: string,
  ): Promise<void> {
    this.verificationAttempts.push({ challenge, code });
  }

  async resendVerificationCode(
    challenge: SupernoteVerificationChallenge,
  ): Promise<SupernoteVerificationChallenge> {
    this.resendAttempts.push(challenge);
    return challenge;
  }
}
