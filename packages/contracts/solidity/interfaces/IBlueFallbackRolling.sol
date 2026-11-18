// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 Morpho Association
//
// VENDORED from morpho-org/midnight `src/periphery/blue-fallback-rolling/interfaces/IBlueFallbackRolling.sol`
// as deployed on Base at 0x7bfa8207b818cc0e23a7abdcbe56572fabca831f. `Market` and `MarketParams` are
// inlined so the ABI is self-contained; the Blue supply-collateral callback is omitted (only Blue calls it).
pragma solidity >=0.5.0;

struct CollateralParams {
    address token;
    uint256 lltv;
    uint256 liquidationCursor;
    address oracle;
}

struct Market {
    uint256 chainId;
    address midnight;
    address loanToken;
    CollateralParams[] collateralParams;
    uint256 maturity;
    uint256 rcfThreshold;
    address enterGate;
    address liquidatorGate;
}

struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

interface IBlueFallbackRolling {
    error DecreasingIncentive();
    error Ended();
    error EndNotAfterStart();
    error IncentiveTooHigh();
    error IncorrectActivatedCollateral();
    error InconsistentCollateralToken();
    error InconsistentLoanToken();
    error LiquidationLocked();
    error NotBlue();
    error NotConfigured();
    error NotStarted();
    error RolledAssetsTooLow();
    error Unauthorized();

    event SetConfig(address caller, address indexed user, bytes32 indexed midnightId, bytes32 indexed blueId, uint256 start, uint256 end, uint256 incentiveAtStart, uint256 incentiveAtEnd, uint256 minRollableAssets, bool enabled);
    event Roll(address caller, address indexed user, bytes32 indexed midnightId, bytes32 indexed blueId, bytes32 configId, uint256 debtAssets, uint256 collateralAssets, uint256 incentiveAssets);

    function MIDNIGHT() external view returns (address);
    function BLUE() external view returns (address);
    function isConfig(address user, bytes32 configId) external view returns (bool);

    function setConfig(address user, bytes32 midnightId, bytes32 blueId, uint256 start, uint256 end, uint256 incentiveAtStart, uint256 incentiveAtEnd, uint256 minRollableAssets, bool enabled) external;
    function roll(Market memory midnightMarket, MarketParams memory blueMarketParams, address user, uint256 start, uint256 end, uint256 incentiveAtStart, uint256 incentiveAtEnd, uint256 minRollableAssets, uint256 assets) external;
}
