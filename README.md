# celogovernance - Parse and read CELO governance proposals.

```
$: npm install -g celogovernance
$: celogovernance
$: celogovernance --proposalID <id>
```

Example output:
```
$ celogovernance --proposalID 1
ProposalID: 1
Proposer: https://explorer.celo.org/address/0xF3EB910DA09B8AF348E0E5B6636da442cFa79239
Description: https://gist.github.com/aslawson/a1f693f0e4c5fd391eac463237c4182a
Stage:      Approval
Dequeued:   Wed, 29 Apr 2020 00:28:42 GMT
Referendum: Thu, 30 Apr 2020 00:28:42 GMT
Execution:  Sat, 02 May 2020 00:28:42 GMT
Expires:    Tue, 05 May 2020 00:28:42 GMT
Approved:   TRUE
Passing:    FALSE (voting hasn't started yet!)

Freezer.unfreeze(target=contract.Election:0x8D6677192144292870907E3Fa8A5527fE55A7ff6)
EpochRewards.setCarbonOffsettingFund(
    partner=0x0ba9f5B3CdD349aB65a8DacDA9A38Bc525C2e6D6,
    value=1000000000000000000000,
)
Freezer.unfreeze(target=contract.EpochRewards:0x07F007d389883622Ef8D4d347b3f78007f28d8b7)
```
