#!/bin/bash
#
# This script should be run from the repo's deployment directory
# cd deployment
# ./run-unit-tests.sh
#

[ "$DEBUG" == 'true' ] && set -x
set -e

function headline(){
  echo "------------------------------------------------------------------------------"
  echo "$1"
  echo "------------------------------------------------------------------------------"
}

prepare_jest_coverage_report() {
  local component_name=$(basename "$1")

  if [ ! -d "coverage" ]; then
    echo "ValidationError: Missing required directory coverage after running unit tests"
    exit 129
  fi

  # prepare coverage reports
  rm -fr coverage/lcov-report
  mkdir -p $coverage_reports_top_path/jest
  coverage_report_path=$coverage_reports_top_path/jest/$component_name
  rm -fr $coverage_report_path
  mv coverage $coverage_report_path
}

headline "[Setup] Configure paths"
template_dir="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
image_handler_dir="$template_dir/../source/image-handler" 
coverage_reports_top_path="$template_dir/../source/test/coverage-reports"

headline "[Tests] Run unit tests"
declare -a packages=(
  "$image_handler_dir"
)
for package in "${packages[@]}"; do
  cd "$package"
  npm test
  prepare_jest_coverage_report "$package"
done;